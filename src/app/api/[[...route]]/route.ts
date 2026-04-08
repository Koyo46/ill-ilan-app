import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

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

  if (room.status !== "waiting") {
    return c.json({ error: "This room is not accepting new players" }, 409);
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

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({
      room_id: roomId,
      name: playerName,
      is_host: false,
    })
    .select("*")
    .single();

  if (playerError) {
    return c.json({ error: playerError.message }, 500);
  }

  return c.json({ player }, 201);
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

  const currentPlayerId =
    requestedCurrentPlayerId && players.some((player) => player.id === requestedCurrentPlayerId)
      ? requestedCurrentPlayerId
      : players[0].id;

  const { error: updateRoomError } = await supabase
    .from("rooms")
    .update({ status: "playing" })
    .eq("id", roomId);

  if (updateRoomError) {
    return c.json({ error: updateRoomError.message }, 500);
  }

  const { data: gameState, error: gameStateError } = await supabase
    .from("game_states")
    .upsert(
      {
        room_id: roomId,
        turn: 1,
        current_player_id: currentPlayerId,
        draw_pile: [],
        discard_pile: [],
        table_cards: [],
        event_log: [],
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
