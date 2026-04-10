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

type VoteCardBody = {
  playerId?: string;
  wantsCard?: boolean;
};

type ResolveTableCardBody = {
  playerId?: string;
  receiverPlayerId?: string;
};

type StartGameBody = {
  requesterPlayerId?: string;
  currentPlayerId?: string;
};

type RematchBody = {
  playerId?: string;
};

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const countBombsFromCollectedCards = (cards: number[]) => {
  const counts = new Map<number, number>();
  for (const card of cards) {
    counts.set(card, (counts.get(card) ?? 0) + 1);
  }

  let bombs = 0;
  for (const [value, count] of counts.entries()) {
    if (value >= 10) {
      bombs += count;
    } else {
      bombs += Math.floor(count / 2);
    }
  }
  return bombs;
};

const sumCards = (cards: number[]) => cards.reduce((sum, card) => sum + card, 0);

const shuffleArray = <T>(input: T[]) => {
  const cloned = [...input];
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = cloned[i];
    cloned[i] = cloned[j];
    cloned[j] = temp;
  }
  return cloned;
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

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("status")
    .eq("id", roomId)
    .single();
  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }

  const { data, error } = await supabase
    .from("game_states")
    .select("*")
    .eq("room_id", roomId)
    .single();

  if (error) {
    return c.json({ error: error.message }, 404);
  }

  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("id,name,collected_cards,joined_at")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  if (playersError) {
    return c.json({ error: playersError.message }, 500);
  }

  const currentTurnPlayerId = data.current_player_id as string | null;
  const currentTurn = Number(data.turn ?? 1);
  const targetVoterIds = (players ?? [])
    .map((player) => player.id as string)
    .filter((playerId) => playerId !== currentTurnPlayerId);

  const { data: voteRows, error: votesError } = await supabase
    .from("card_votes")
    .select("voter_player_id, wants_card")
    .eq("room_id", roomId)
    .eq("turn", currentTurn);
  if (votesError) {
    return c.json({ error: votesError.message }, 500);
  }

  const voteByPlayer = new Map<string, boolean>();
  for (const vote of voteRows ?? []) {
    voteByPlayer.set(vote.voter_player_id as string, Boolean(vote.wants_card));
  }

  const submittedCount = targetVoterIds.filter((playerId) => voteByPlayer.has(playerId)).length;
  const allVotesSubmitted = submittedCount === targetVoterIds.length;
  const needPlayerIds = targetVoterIds.filter((playerId) => voteByPlayer.get(playerId) === true);
  const forcedAllNeed = allVotesSubmitted && needPlayerIds.length === 0 && targetVoterIds.length > 0;
  const eligibleReceiverPlayerIds = !allVotesSubmitted
    ? []
    : [
        ...(currentTurnPlayerId ? [currentTurnPlayerId] : []),
        ...(forcedAllNeed ? targetVoterIds : needPlayerIds),
      ];

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
  const drawPile = Array.isArray(data.draw_pile) ? data.draw_pile : [];
  const drawPileCompositionMap = new Map<number, number>();
  for (const rawCard of [...drawPile, ...tableCards]) {
    if (typeof rawCard !== "number") {
      continue;
    }
    drawPileCompositionMap.set(rawCard, (drawPileCompositionMap.get(rawCard) ?? 0) + 1);
  }
  const drawPileComposition = Array.from(drawPileCompositionMap.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value);
  const maskedGameState = {
    ...data,
    // 山札の実体はクライアントへ返さない
    draw_pile: [],
    draw_pile_count: drawPile.length,
    draw_pile_composition: drawPileComposition,
    table_cards: tableCardsHidden ? tableCards.map(() => null) : tableCards,
  };

  const isViewerCurrentPlayer = viewerPlayerId != null && viewerPlayerId === currentTurnPlayerId;
  const myVote =
    viewerPlayerId && targetVoterIds.includes(viewerPlayerId)
      ? (voteByPlayer.get(viewerPlayerId) ?? null)
      : null;
  const votesByPlayer = Object.fromEntries(
    targetVoterIds.map((playerId) => [playerId, voteByPlayer.has(playerId) ? voteByPlayer.get(playerId) : null]),
  );
  const winnerByUniqueCards = (players ?? []).find((player) => {
    const collectedCards = Array.isArray(player.collected_cards) ? player.collected_cards : [];
    return new Set(collectedCards).size >= 5;
  });
  const winnerByHighestSumWhenFinished =
    room.status === "finished" && (players ?? []).length > 0
      ? (players ?? []).reduce((best, player) => {
          const cards = Array.isArray(player.collected_cards) ? player.collected_cards : [];
          const score = sumCards(cards);
          if (!best || score > best.score) {
            return { player, score };
          }
          return best;
        }, null as { player: (typeof players)[number]; score: number } | null)
      : null;
  const winnerPlayer = winnerByUniqueCards ?? winnerByHighestSumWhenFinished?.player ?? null;
  const eventLog = Array.isArray(data.event_log) ? data.event_log : [];
  const latestWinnerLog = [...eventLog]
    .reverse()
    .find((log) => typeof log === "string" && log.includes("勝利"));
  const winnerReason: "unique" | "score" | null =
    typeof latestWinnerLog === "string" && latestWinnerLog.includes("種類達成")
      ? "unique"
      : typeof latestWinnerLog === "string" && latestWinnerLog.includes("合計")
        ? "score"
        : winnerByUniqueCards
          ? "unique"
          : winnerByHighestSumWhenFinished
            ? "score"
            : null;

  return c.json({
    gameState: maskedGameState,
    tableCardsHidden,
    voteState: {
      turn: currentTurn,
      totalVoters: targetVoterIds.length,
      submittedCount,
      allVotesSubmitted,
      forcedAllNeed,
      eligibleReceiverPlayerIds,
      needCount: forcedAllNeed ? targetVoterIds.length : needPlayerIds.length,
      passCount: allVotesSubmitted
        ? 0
        : targetVoterIds.filter((playerId) => voteByPlayer.get(playerId) === false).length,
      canVote: Boolean(viewerPlayerId && targetVoterIds.includes(viewerPlayerId)),
      canResolve:
        Boolean(isViewerCurrentPlayer && allVotesSubmitted && Array.isArray(data.table_cards) && data.table_cards.length > 0),
      myVote,
      votesByPlayer,
    },
    winner: winnerPlayer
      ? {
          playerId: winnerPlayer.id,
          playerName: winnerPlayer.name,
          uniqueCardCount: new Set(
            Array.isArray(winnerPlayer.collected_cards) ? winnerPlayer.collected_cards : [],
          ).size,
          score: sumCards(Array.isArray(winnerPlayer.collected_cards) ? winnerPlayer.collected_cards : []),
          reason: winnerReason,
        }
      : null,
  });
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

// POST /api/rooms/:roomId/vote
// 手番以外のプレイヤーが場カードへの意思表示(いる/いらない)を行うAPI
app.post("/rooms/:roomId/vote", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<VoteCardBody>(c.req.raw);
  const playerId = body?.playerId;
  const wantsCard = body?.wantsCard;

  if (!playerId || typeof wantsCard !== "boolean") {
    return c.json({ error: "playerId and wantsCard are required" }, 400);
  }

  const supabase = getSupabaseAdminClient();
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("status")
    .eq("id", roomId)
    .single();
  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }
  if (room.status !== "playing") {
    return c.json({ error: "Voting is only available while playing" }, 409);
  }

  const { data: gameState, error: gameStateError } = await supabase
    .from("game_states")
    .select("*")
    .eq("room_id", roomId)
    .single();
  if (gameStateError || !gameState) {
    return c.json({ error: "Game state not found" }, 404);
  }

  if (gameState.current_player_id === playerId) {
    return c.json({ error: "Current turn player cannot vote" }, 409);
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("id")
    .eq("id", playerId)
    .eq("room_id", roomId)
    .maybeSingle();
  if (playerError || !player) {
    return c.json({ error: "Player not found in this room" }, 404);
  }

  const { data: existingVote, error: existingVoteError } = await supabase
    .from("card_votes")
    .select("id")
    .eq("room_id", roomId)
    .eq("turn", Number(gameState.turn))
    .eq("voter_player_id", playerId)
    .maybeSingle();
  if (existingVoteError) {
    return c.json({ error: existingVoteError.message }, 500);
  }
  if (existingVote) {
    return c.json({ error: "Vote already confirmed for this turn" }, 409);
  }

  const { error: insertVoteError } = await supabase
    .from("card_votes")
    .insert({
      room_id: roomId,
      turn: Number(gameState.turn),
      voter_player_id: playerId,
      wants_card: wantsCard,
    });
  if (insertVoteError) {
    return c.json({ error: insertVoteError.message }, 500);
  }

  return c.json({ success: true });
});

// POST /api/rooms/:roomId/resolve-table-card
// 手番プレイヤーが場カードの受取先を確定してターンを進めるAPI
app.post("/rooms/:roomId/resolve-table-card", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<ResolveTableCardBody>(c.req.raw);
  const playerId = body?.playerId;
  const receiverPlayerId = body?.receiverPlayerId;

  if (!playerId || !receiverPlayerId) {
    return c.json({ error: "playerId and receiverPlayerId are required" }, 400);
  }

  const supabase = getSupabaseAdminClient();
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("status")
    .eq("id", roomId)
    .single();
  if (roomError || !room) {
    return c.json({ error: "Room not found" }, 404);
  }
  if (room.status !== "playing") {
    return c.json({ error: "Resolve is only available while playing" }, 409);
  }

  const { data: gameState, error: gameStateError } = await supabase
    .from("game_states")
    .select("*")
    .eq("room_id", roomId)
    .single();
  if (gameStateError || !gameState) {
    return c.json({ error: "Game state not found" }, 404);
  }

  if (gameState.current_player_id !== playerId) {
    return c.json({ error: "Only current turn player can resolve table card" }, 403);
  }

  const tableCards = Array.isArray(gameState.table_cards) ? gameState.table_cards : [];
  const tableCard = tableCards[0];
  if (typeof tableCard !== "number") {
    return c.json({ error: "No resolvable table card" }, 409);
  }

  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  if (playersError || !players) {
    return c.json({ error: playersError?.message ?? "Players not found" }, 500);
  }

  const currentTurn = Number(gameState.turn);
  const targetVoterIds = players
    .map((player) => player.id as string)
    .filter((id) => id !== playerId);

  const { data: voteRows, error: votesError } = await supabase
    .from("card_votes")
    .select("voter_player_id, wants_card")
    .eq("room_id", roomId)
    .eq("turn", currentTurn);
  if (votesError) {
    return c.json({ error: votesError.message }, 500);
  }

  const voteByPlayer = new Map<string, boolean>();
  for (const vote of voteRows ?? []) {
    voteByPlayer.set(vote.voter_player_id as string, Boolean(vote.wants_card));
  }

  const allVotesSubmitted = targetVoterIds.every((id) => voteByPlayer.has(id));
  if (!allVotesSubmitted) {
    return c.json({ error: "Cannot resolve before all non-turn players vote" }, 409);
  }

  const needPlayerIds = targetVoterIds.filter((id) => voteByPlayer.get(id) === true);
  const forcedAllNeed = needPlayerIds.length === 0 && targetVoterIds.length > 0;
  const eligibleReceiverPlayerIds = [
    playerId,
    ...(forcedAllNeed ? targetVoterIds : needPlayerIds),
  ];

  if (!eligibleReceiverPlayerIds.includes(receiverPlayerId)) {
    return c.json({ error: "Receiver is not eligible for this turn" }, 409);
  }

  const receiver = players.find((player) => player.id === receiverPlayerId);
  if (!receiver) {
    return c.json({ error: "Receiver player not found" }, 404);
  }

  const currentCollectedCards = Array.isArray(receiver.collected_cards) ? receiver.collected_cards : [];
  const nextCollectedCards = [...currentCollectedCards, tableCard];
  const nextBombCount = countBombsFromCollectedCards(nextCollectedCards);
  const { error: updateReceiverError } = await supabase
    .from("players")
    .update({ collected_cards: nextCollectedCards, bombs: nextBombCount })
    .eq("id", receiverPlayerId);
  if (updateReceiverError) {
    return c.json({ error: updateReceiverError.message }, 500);
  }

  const isEliminatedByBomb = nextBombCount >= 2;
  const uniqueCardCount = new Set(nextCollectedCards).size;
  const isWinnerByUniqueCards = uniqueCardCount >= 5;

  const drawPile = Array.isArray(gameState.draw_pile) ? [...gameState.draw_pile] : [];
  const nextTableCard = drawPile.pop();
  const nextTableCards = typeof nextTableCard === "number" ? [nextTableCard] : [];
  const currentEventLog = Array.isArray(gameState.event_log) ? gameState.event_log : [];
  const receiverLabel = receiver.id === playerId ? `${receiver.name}(手番)` : receiver.name;
  const voteModeLog = forcedAllNeed
    ? "全員いらないのため、全員いる扱いで候補化"
    : "いると答えたプレイヤーから選択";
  const baseTurnLog = `ターン${currentTurn}: ${receiverLabel} が場のカード ${tableCard} を受け取りました (${voteModeLog})`;

  let updatedGameState: Record<string, unknown> | null = null;

  if (isEliminatedByBomb) {
    const { error: deleteEliminatedPlayerError } = await supabase
      .from("players")
      .delete()
      .eq("id", receiver.id);
    if (deleteEliminatedPlayerError) {
      return c.json({ error: deleteEliminatedPlayerError.message }, 500);
    }

    const { data: remainingPlayers, error: remainingPlayersError } = await supabase
      .from("players")
      .select("*")
      .eq("room_id", roomId)
      .order("joined_at", { ascending: true });
    if (remainingPlayersError) {
      return c.json({ error: remainingPlayersError.message }, 500);
    }

    const winnerByScore = (remainingPlayers ?? []).reduce((best, player) => {
      const cards = Array.isArray(player.collected_cards) ? player.collected_cards : [];
      const score = sumCards(cards);
      if (!best || score > best.score) {
        return { player, score };
      }
      return best;
    }, null as { player: (typeof players)[number]; score: number } | null);

    const eliminationLog = `💥 ${receiver.name} が爆弾2個で脱落しました`;
    const winnerLog = winnerByScore
      ? `🏆 ${winnerByScore.player.name} が合計 ${winnerByScore.score} 点で勝利しました！`
      : "🏆 勝者なしでゲーム終了";

    const { data: finishedGameState, error: finishGameStateError } = await supabase
      .from("game_states")
      .update({
        turn: currentTurn,
        current_player_id: winnerByScore?.player.id ?? null,
        draw_pile: drawPile,
        table_cards: [],
        event_log: [...currentEventLog, baseTurnLog, eliminationLog, winnerLog],
      })
      .eq("room_id", roomId)
      .select("*")
      .single();
    if (finishGameStateError) {
      return c.json({ error: finishGameStateError.message }, 500);
    }
    updatedGameState = finishedGameState;

    const { error: finishRoomError } = await supabase
      .from("rooms")
      .update({ status: "finished" })
      .eq("id", roomId);
    if (finishRoomError) {
      return c.json({ error: finishRoomError.message }, 500);
    }
  } else {
    const currentPlayerIndex = players.findIndex((player) => player.id === playerId);
    const nextPlayer =
      currentPlayerIndex >= 0 ? players[(currentPlayerIndex + 1) % players.length] : players[0];
    const winnerLog = isWinnerByUniqueCards
      ? `🏆 ${receiver.name} が ${uniqueCardCount} 種類達成で勝利しました！`
      : null;

    const { data: progressedGameState, error: updateGameStateError } = await supabase
      .from("game_states")
      .update({
        turn: isWinnerByUniqueCards ? currentTurn : currentTurn + 1,
        current_player_id: isWinnerByUniqueCards ? playerId : nextPlayer?.id ?? playerId,
        draw_pile: drawPile,
        table_cards: isWinnerByUniqueCards ? [] : nextTableCards,
        event_log: [...currentEventLog, baseTurnLog, ...(winnerLog ? [winnerLog] : [])],
      })
      .eq("room_id", roomId)
      .select("*")
      .single();
    if (updateGameStateError) {
      return c.json({ error: updateGameStateError.message }, 500);
    }
    updatedGameState = progressedGameState;

    if (isWinnerByUniqueCards) {
      const { error: finishRoomError } = await supabase
        .from("rooms")
        .update({ status: "finished" })
        .eq("id", roomId);
      if (finishRoomError) {
        return c.json({ error: finishRoomError.message }, 500);
      }
    }
  }

  const { error: deleteVotesError } = await supabase
    .from("card_votes")
    .delete()
    .eq("room_id", roomId)
    .eq("turn", currentTurn);
  if (deleteVotesError) {
    return c.json({ error: deleteVotesError.message }, 500);
  }

  return c.json({ success: true, gameState: updatedGameState });
});

// POST /api/rooms/:roomId/rematch
// 再戦API（山札再生成・再配布・手番ランダム・場札1枚で再開）
app.post("/rooms/:roomId/rematch", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<RematchBody>(c.req.raw);
  const playerId = body?.playerId;

  if (!playerId) {
    return c.json({ error: "playerId is required" }, 400);
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
  if (room.status !== "finished") {
    return c.json({ error: "Rematch is only available after game finished" }, 409);
  }

  const { data: requestingPlayer, error: requestingPlayerError } = await supabase
    .from("players")
    .select("id")
    .eq("id", playerId)
    .eq("room_id", roomId)
    .maybeSingle();
  if (requestingPlayerError || !requestingPlayer) {
    return c.json({ error: "Player not found in this room" }, 404);
  }

  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });
  if (playersError || !players) {
    return c.json({ error: playersError?.message ?? "Players not found" }, 500);
  }
  if (players.length === 0) {
    return c.json({ error: "At least one player is required for rematch" }, 400);
  }

  const randomizedPlayers = shuffleArray(players);
  const initialDeck = generateInitialDeck();
  const distributedCards = new Map<string, number>();
  for (let i = 0; i < randomizedPlayers.length; i += 1) {
    const card = initialDeck.pop();
    if (typeof card !== "number") {
      return c.json({ error: "Failed to distribute cards for rematch" }, 500);
    }
    distributedCards.set(randomizedPlayers[i].id, card);
  }
  const firstTableCard = initialDeck.pop();
  if (typeof firstTableCard !== "number") {
    return c.json({ error: "Failed to initialize table card for rematch" }, 500);
  }

  for (let i = 0; i < randomizedPlayers.length; i += 1) {
    const player = randomizedPlayers[i];
    const collectedCard = distributedCards.get(player.id);
    if (typeof collectedCard !== "number") {
      return c.json({ error: "Failed to assign rematch card" }, 500);
    }

    // joined_at を更新してプレイ順をランダム化
    const randomizedJoinedAt = new Date(Date.now() + i * 1000).toISOString();
    const collectedCards = [collectedCard];
    const bombs = countBombsFromCollectedCards(collectedCards);

    const { error: updatePlayerError } = await supabase
      .from("players")
      .update({
        joined_at: randomizedJoinedAt,
        collected_cards: collectedCards,
        bombs,
      })
      .eq("id", player.id);
    if (updatePlayerError) {
      return c.json({ error: updatePlayerError.message }, 500);
    }
  }

  const currentPlayer = randomizedPlayers[Math.floor(Math.random() * randomizedPlayers.length)];

  const { error: clearVotesError } = await supabase.from("card_votes").delete().eq("room_id", roomId);
  if (clearVotesError) {
    return c.json({ error: clearVotesError.message }, 500);
  }

  const { data: gameState, error: gameStateError } = await supabase
    .from("game_states")
    .upsert(
      {
        room_id: roomId,
        turn: 1,
        current_player_id: currentPlayer.id,
        draw_pile: initialDeck,
        table_cards: [firstTableCard],
        event_log: [`再戦が開始されました (${new Date().toISOString()})`],
      },
      { onConflict: "room_id" },
    )
    .select("*")
    .single();
  if (gameStateError) {
    return c.json({ error: gameStateError.message }, 500);
  }

  const { error: updateRoomError } = await supabase
    .from("rooms")
    .update({ status: "playing" })
    .eq("id", roomId);
  if (updateRoomError) {
    return c.json({ error: updateRoomError.message }, 500);
  }

  return c.json({ success: true, gameState });
});

// POST /api/rooms/:roomId/start
// ゲーム開始API（rooms.statusをplayingに更新し、game_statesを初期化）
app.post("/rooms/:roomId/start", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await parseJsonBody<StartGameBody>(c.req.raw);
  const requesterPlayerId = body?.requesterPlayerId;
  const requestedCurrentPlayerId = body?.currentPlayerId;
  const supabase = getSupabaseAdminClient();

  if (!requesterPlayerId) {
    return c.json({ error: "requesterPlayerId is required" }, 400);
  }

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

  const { data: requesterPlayer, error: requesterPlayerError } = await supabase
    .from("players")
    .select("id,is_host")
    .eq("id", requesterPlayerId)
    .eq("room_id", roomId)
    .maybeSingle();
  if (requesterPlayerError || !requesterPlayer) {
    return c.json({ error: "Requester player not found in this room" }, 404);
  }
  if (!requesterPlayer.is_host) {
    return c.json({ error: "Only host can start game" }, 403);
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

  // ゲーム開始条件は「満員」ではなく「最大人数以下」であれば開始可能
  if (players.length > room.max_players) {
    return c.json({ error: "Player count exceeds room capacity" }, 409);
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
    const initialCollectedCards = [collectedCard];
    const initialBombs = countBombsFromCollectedCards(initialCollectedCards);

    const { error: updatePlayerError } = await supabase
      .from("players")
      .update({ collected_cards: initialCollectedCards, bombs: initialBombs })
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
