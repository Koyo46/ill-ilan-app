import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { generateInitialDeck } from "@/lib/game-logic";

export const runtime = "edge";

const app = new Hono().basePath("/api");

// GET /api/hello
// 疎通確認用のヘルスチェックAPI
app.get("/hello", (c) => {
  return c.json({
    message: "Hello from Hono!",
  });
});

type CreateRoomBody = {
  roomName?: string;
  playerName?: string;
  maxPlayers?: number;
};

type JoinRoomBody = {
  playerName?: string;
};

type LeaveRoomBody = {
  playerId?: string;
};

type DeleteRoomBody = {
  playerId?: string;
};

type StartGameBody = {
  currentPlayerId?: string;
};

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

// GET /api/rooms
// 部屋一覧を新しい順で取得するAPI
app.get("/rooms", async (c) => {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ rooms: data ?? [] });
});

// GET /api/rooms/:roomId
// 指定部屋の詳細を取得するAPI
app.get("/rooms/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase.from("rooms").select("*").eq("id", roomId).single();

  if (error) {
    return c.json({ error: "Room not found" }, 404);
  }

  return c.json({ room: data });
});

// GET /api/rooms/:roomId/players
// 指定部屋のプレイヤー一覧を参加順で取得するAPI
app.get("/rooms/:roomId/players", async (c) => {
  const roomId = c.req.param("roomId");
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ players: data ?? [] });
});

// GET /api/rooms/:roomId/game-state
// 指定部屋のゲーム状態を取得するAPI
// viewerPlayerId が現在手番のプレイヤーなら table_cards はマスクして返す
app.get("/rooms/:roomId/game-state", async (c) => {
  const roomId = c.req.param("roomId");
  const viewerPlayerId = c.req.query("viewerPlayerId");
  const supabase = getSupabaseAdminClient();

  const { data, error } = await supabase
    .from("game_states")
    .select("*")
    .eq("room_id", roomId)
    .single();

  if (error) {
    return c.json({ error: error.message }, 404);
  }

  let tableCardsHidden = true;
  if (viewerPlayerId) {
    const { data: viewerPlayer, error: viewerPlayerError } = await supabase
      .from("players")
      .select("id")
      .eq("id", viewerPlayerId)
      .eq("room_id", roomId)
      .maybeSingle();

    if (!viewerPlayerError && viewerPlayer) {
      tableCardsHidden = data.current_player_id === viewerPlayerId;
    }
  }

  const tableCards = Array.isArray(data.table_cards) ? data.table_cards : [];
  const maskedGameState = tableCardsHidden
    ? { ...data, table_cards: tableCards.map(() => null) }
    : data;

  return c.json({ gameState: maskedGameState, tableCardsHidden });
});

// POST /api/rooms
// 部屋を作成し、同時に最初のプレイヤーをホスト(is_host=true)で登録するAPI
app.post("/rooms", async (c) => {
  const body = await parseJsonBody<CreateRoomBody>(c.req.raw);
  const roomName = body?.roomName?.trim();
  const playerName = body?.playerName?.trim();
  const maxPlayers = body?.maxPlayers ?? 4;

  if (!roomName || !playerName) {
    return c.json({ error: "roomName and playerName are required" }, 400);
  }

  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8) {
    return c.json({ error: "maxPlayers must be an integer between 2 and 8" }, 400);
  }

  const supabase = getSupabaseAdminClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .insert({
      name: roomName,
      max_players: maxPlayers,
    })
    .select("*")
    .single();

  if (roomError) {
    return c.json({ error: roomError.message }, 500);
  }

  const { data: hostPlayer, error: playerError } = await supabase
    .from("players")
    .insert({
      room_id: room.id,
      name: playerName,
      is_host: true,
    })
    .select("*")
    .single();

  if (playerError) {
    await supabase.from("rooms").delete().eq("id", room.id);
    return c.json({ error: playerError.message }, 500);
  }

  return c.json({ room, hostPlayer }, 201);
});

// POST /api/rooms/:roomId/join
// 指定部屋に一般プレイヤーとして参加するAPI（waiting状態かつ定員未満のみ）
app.post("/rooms/:roomId/join", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<JoinRoomBody>(c.req.raw);
  const playerName = body?.playerName?.trim();

  if (!playerName) {
    return c.json({ error: "playerName is required" }, 400);
  }

  const supabase = getSupabaseAdminClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }

  const { count, error: countError } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId);

  if (countError) {
    return c.json({ error: countError.message }, 500);
  }

  if ((count ?? 0) >= room.max_players) {
    return c.json({ error: "Room is full" }, 409);
  }

  const isFirstPlayer = (count ?? 0) === 0;

  // 空部屋として再オープンするケースでは、finished -> waiting へ戻して参加を許可する
  if (room.status === "finished" && isFirstPlayer) {
    const { error: reopenRoomError } = await supabase
      .from("rooms")
      .update({ status: "waiting" })
      .eq("id", roomId);
    if (reopenRoomError) {
      return c.json({ error: reopenRoomError.message }, 500);
    }
  } else if (room.status !== "waiting") {
    return c.json({ error: "This room is not accepting new players" }, 409);
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({
      room_id: roomId,
      name: playerName,
      is_host: isFirstPlayer,
    })
    .select("*")
    .single();

  if (playerError) {
    return c.json({ error: playerError.message }, 500);
  }

  return c.json({ player }, 201);
});

// POST /api/rooms/:roomId/leave
// 指定部屋からプレイヤーを離脱させるAPI（ホスト離脱時は次ホストに委譲、最後の1人なら部屋削除）
app.post("/rooms/:roomId/leave", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<LeaveRoomBody>(c.req.raw);
  const playerId = body?.playerId;

  if (!playerId) {
    return c.json({ error: "playerId is required" }, 400);
  }

  const supabase = getSupabaseAdminClient();

  const { data: leavingPlayer, error: playerLookupError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .eq("room_id", roomId)
    .single();

  if (playerLookupError || !leavingPlayer) {
    return c.json({ error: "Player not found in this room" }, 404);
  }

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }

  const { data: gameState, error: gameStateLookupError } = await supabase
    .from("game_states")
    .select("*")
    .eq("room_id", roomId)
    .maybeSingle();

  if (gameStateLookupError) {
    return c.json({ error: gameStateLookupError.message }, 500);
  }

  const { data: playersBeforeLeave, error: playersBeforeLeaveError } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (playersBeforeLeaveError) {
    return c.json({ error: playersBeforeLeaveError.message }, 500);
  }

  const remainingPlayersAfterLeave = (playersBeforeLeave ?? []).filter((player) => player.id !== playerId);

  const { error: deletePlayerError } = await supabase.from("players").delete().eq("id", playerId);
  if (deletePlayerError) {
    return c.json({ error: deletePlayerError.message }, 500);
  }

  if (remainingPlayersAfterLeave.length === 0) {
    const { error: deleteGameStateError } = await supabase
      .from("game_states")
      .delete()
      .eq("room_id", roomId);
    if (deleteGameStateError) {
      return c.json({ error: deleteGameStateError.message }, 500);
    }

    // 最後の1人が離脱した場合、部屋は残しつつwaitingへ戻して再参加可能にする
    const { error: finishRoomError } = await supabase
      .from("rooms")
      .update({ status: "waiting" })
      .eq("id", roomId);
    if (finishRoomError) {
      return c.json({ error: finishRoomError.message }, 500);
    }

    return c.json({ leftPlayerId: playerId, roomDeleted: true });
  }

  if (leavingPlayer.is_host) {
    const nextHost = remainingPlayersAfterLeave[0];
    const { error: promoteHostError } = await supabase
      .from("players")
      .update({ is_host: true })
      .eq("id", nextHost.id);

    if (promoteHostError) {
      return c.json({ error: promoteHostError.message }, 500);
    }
  }

  if (gameState && gameState.current_player_id === playerId) {
    const nextPlayer = remainingPlayersAfterLeave[0];
    const currentEventLog = Array.isArray(gameState.event_log) ? gameState.event_log : [];
    const { error: updateGameStateError } = await supabase
      .from("game_states")
      .update({
        current_player_id: nextPlayer?.id ?? null,
        event_log: [...currentEventLog, `${leavingPlayer.name} が離脱しました`],
      })
      .eq("room_id", roomId);
    if (updateGameStateError) {
      return c.json({ error: updateGameStateError.message }, 500);
    }
  }

  return c.json({ leftPlayerId: playerId, roomDeleted: false });
});

// POST /api/rooms/:roomId/delete
// ホスト本人のみ部屋を削除できるAPI
app.post("/rooms/:roomId/delete", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<DeleteRoomBody>(c.req.raw);
  const playerId = body?.playerId;

  if (!playerId) {
    return c.json({ error: "playerId is required" }, 400);
  }

  const supabase = getSupabaseAdminClient();

  const { data: hostPlayer, error: hostLookupError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .eq("room_id", roomId)
    .single();

  if (hostLookupError || !hostPlayer) {
    return c.json({ error: "Player not found in this room" }, 404);
  }

  if (!hostPlayer.is_host) {
    return c.json({ error: "Only host can delete room" }, 403);
  }

  const { error: deleteGameStateError } = await supabase
    .from("game_states")
    .delete()
    .eq("room_id", roomId);
  if (deleteGameStateError) {
    return c.json({ error: deleteGameStateError.message }, 500);
  }

  const { error: deletePlayersError } = await supabase.from("players").delete().eq("room_id", roomId);
  if (deletePlayersError) {
    return c.json({ error: deletePlayersError.message }, 500);
  }

  const { error: deleteRoomError } = await supabase.from("rooms").delete().eq("id", roomId);
  if (deleteRoomError) {
    return c.json({ error: deleteRoomError.message }, 500);
  }

  return c.json({ deleted: true });
});

// POST /api/rooms/:roomId/start
// ゲーム開始API（rooms.statusをplayingに更新し、game_statesを初期化）
app.post("/rooms/:roomId/start", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<StartGameBody>(c.req.raw);
  const requestedCurrentPlayerId = body?.currentPlayerId;
  const supabase = getSupabaseAdminClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }

  if (room.status !== "waiting") {
    return c.json({ error: "Game already started or finished" }, 409);
  }

  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (playersError) {
    return c.json({ error: playersError.message }, 500);
  }

  if (!players || players.length === 0) {
    return c.json({ error: "At least one player is required" }, 400);
  }

  const randomPlayer = players[Math.floor(Math.random() * players.length)];
  const currentPlayerId =
    requestedCurrentPlayerId && players.some((player) => player.id === requestedCurrentPlayerId)
      ? requestedCurrentPlayerId
      : randomPlayer.id;

  const initialDeck = generateInitialDeck();
  const distributedCards = new Map<string, number>();
  for (let i = 0; i < players.length; i += 1) {
    const card = initialDeck.pop();
    if (typeof card !== "number") {
      return c.json({ error: "Failed to distribute collected cards" }, 500);
    }
    distributedCards.set(players[i].id, card);
  }

  if (distributedCards.size !== players.length) {
    return c.json({ error: "Failed to initialize deck" }, 500);
  }

  const firstTableCard = initialDeck.pop();
  if (typeof firstTableCard !== "number") {
    return c.json({ error: "Failed to initialize table card" }, 500);
  }

  const { error: updateRoomError } = await supabase
    .from("rooms")
    .update({ status: "playing" })
    .eq("id", roomId);

  if (updateRoomError) {
    return c.json({ error: updateRoomError.message }, 500);
  }

  for (const player of players) {
    const collectedCard = distributedCards.get(player.id);
    if (typeof collectedCard !== "number") {
      return c.json({ error: "Failed to assign collected card" }, 500);
    }

    const { error: updatePlayerError } = await supabase
      .from("players")
      .update({ collected_cards: [collectedCard] })
      .eq("id", player.id);

    if (updatePlayerError) {
      return c.json({ error: updatePlayerError.message }, 500);
    }
  }

  const { data: gameState, error: gameStateError } = await supabase
    .from("game_states")
    .upsert(
      {
        room_id: roomId,
        turn: 1,
        current_player_id: currentPlayerId,
        draw_pile: initialDeck,
        discard_pile: [],
        table_cards: [firstTableCard],
        event_log: [`ゲームが開始されました (${new Date().toISOString()})`],
      },
      { onConflict: "room_id" },
    )
    .select("*")
    .single();

  if (gameStateError) {
    return c.json({ error: gameStateError.message }, 500);
  }

  return c.json({ gameState });
});

export const GET = handle(app);
export const POST = handle(app);
