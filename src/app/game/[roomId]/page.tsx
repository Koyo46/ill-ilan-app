"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { Card } from "@/app/components/Card";
import { PlayerZone } from "@/app/components/PlayerZone";

type Room = {
  id: string;
  name: string;
  status: "waiting" | "playing" | "finished";
  max_players: number;
  created_at: string;
};

type Player = {
  id: string;
  room_id: string;
  name: string;
  is_host: boolean;
  joined_at: string;
  collected_cards: number[] | null;
  bombs: number | null;
};

type GameState = {
  room_id: string;
  turn: number;
  current_player_id: string | null;
  draw_pile_count: number;
  draw_pile_composition: Array<{ value: number; count: number }>;
  table_cards: Array<number | null>;
  event_log: string[];
};

type VoteState = {
  turn: number;
  totalVoters: number;
  submittedCount: number;
  allVotesSubmitted: boolean;
  forcedAllNeed: boolean;
  eligibleReceiverPlayerIds: string[];
  needCount: number;
  passCount: number;
  canVote: boolean;
  canResolve: boolean;
  myVote: boolean | null;
  votesByPlayer: Record<string, boolean | null>;
};

type WinnerState = {
  playerId: string;
  playerName: string;
  uniqueCardCount: number;
  score?: number;
  reason?: "unique" | "score" | null;
};

const PLAYER_ID_STORAGE_KEY = "ill-ilan-player-ids-by-room";

const getStoredPlayerIdByRoom = (roomId: string) => {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return map[roomId] ?? null;
  } catch {
    return null;
  }
};

const createErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return "予期せぬエラーが発生しました";
};

export default function GameRoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId;

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tableCardsHidden, setTableCardsHidden] = useState(true);
  const [voteState, setVoteState] = useState<VoteState | null>(null);
  const [pendingVote, setPendingVote] = useState<boolean | null>(null);
  const [winner, setWinner] = useState<WinnerState | null>(null);

  const currentTurnPlayerName = useMemo(() => {
    if (!gameState?.current_player_id) {
      return null;
    }
    return players.find((player) => player.id === gameState.current_player_id)?.name ?? null;
  }, [gameState?.current_player_id, players]);

  const sortedDrawPileComposition = useMemo(() => {
    if (!gameState) {
      return [] as Array<{ value: number; count: number }>;
    }
    return [...(gameState.draw_pile_composition ?? [])].sort((a, b) => a.value - b.value);
  }, [gameState]);

  const drawPileLowCards = useMemo(
    () => sortedDrawPileComposition.filter((card) => card.value < 10),
    [sortedDrawPileComposition],
  );
  const drawPileHighCards = useMemo(
    () => sortedDrawPileComposition.filter((card) => card.value >= 10),
    [sortedDrawPileComposition],
  );

  const isCurrentPlayerInRoom = useMemo(() => {
    if (!currentPlayerId) {
      return false;
    }
    return players.some((player) => player.id === currentPlayerId);
  }, [currentPlayerId, players]);

  const orderedPlayersForBoard = useMemo(() => {
    if (!players.length) {
      return [] as Player[];
    }
    if (!currentPlayerId) {
      return players;
    }
    const selfIndex = players.findIndex((player) => player.id === currentPlayerId);
    if (selfIndex < 0) {
      return players;
    }
    return [...players.slice(selfIndex), ...players.slice(0, selfIndex)];
  }, [currentPlayerId, players]);

  const selfPlayer = useMemo(
    () => orderedPlayersForBoard.find((player) => player.id === currentPlayerId) ?? null,
    [currentPlayerId, orderedPlayersForBoard],
  );

  const otherPlayers = useMemo(
    () => orderedPlayersForBoard.filter((player) => player.id !== currentPlayerId),
    [currentPlayerId, orderedPlayersForBoard],
  );

  const otherPlayerPositions = useMemo(() => {
    const count = otherPlayers.length;
    if (count === 0) {
      return [] as Array<{ left: number; top: number }>;
    }

    if (count === 1) {
      return [{ left: 50, top: 16 }];
    }
    if (count === 2) {
      return [
        { left: 26, top: 20 },
        { left: 74, top: 20 },
      ];
    }
    if (count === 3) {
      return [
        { left: 18, top: 30 },
        { left: 50, top: 14 },
        { left: 82, top: 30 },
      ];
    }

    const centerX = 50;
    const centerY = 56;
    const radius = 40;
    const startAngle = 200;
    const endAngle = 340;
    return Array.from({ length: count }, (_, index) => {
      const angleDeg = startAngle + ((endAngle - startAngle) * index) / (count - 1);
      const angleRad = (angleDeg * Math.PI) / 180;
      return {
        left: centerX + Math.cos(angleRad) * radius,
        top: centerY + Math.sin(angleRad) * radius,
      };
    });
  }, [otherPlayers.length]);

  const otherPlayerZoneWidthClass = useMemo(() => {
    if (otherPlayers.length >= 5) {
      return "w-[150px]";
    }
    if (otherPlayers.length >= 3) {
      return "w-[170px]";
    }
    return "w-[200px]";
  }, [otherPlayers.length]);

  const eligibleReceivers = useMemo(() => {
    if (!voteState) {
      return [] as Player[];
    }
    return players.filter((player) => voteState.eligibleReceiverPlayerIds.includes(player.id));
  }, [players, voteState]);

  const isCurrentTurnPlayer = useMemo(
    () => Boolean(currentPlayerId && gameState?.current_player_id === currentPlayerId),
    [currentPlayerId, gameState?.current_player_id],
  );

  const canResolveLocally = useMemo(
    () =>
      Boolean(
        room?.status === "playing" &&
        isCurrentTurnPlayer &&
          voteState?.allVotesSubmitted &&
          Array.isArray(gameState?.table_cards) &&
          gameState.table_cards.length > 0,
      ),
    [gameState?.table_cards, isCurrentTurnPlayer, room?.status, voteState?.allVotesSubmitted],
  );

  useEffect(() => {
    setPendingVote(voteState?.myVote ?? null);
  }, [voteState?.myVote, voteState?.turn]);

  const getVotePresentation = useCallback(
    (playerId: string): { label: string | null; confirmed: boolean } => {
      if (!voteState || !gameState || playerId === gameState.current_player_id) {
        return { label: null, confirmed: false };
      }

      const confirmedVote = voteState.votesByPlayer[playerId];
      if (typeof confirmedVote === "boolean") {
        return { label: confirmedVote ? "いる" : "いらない", confirmed: true };
      }

      if (playerId === currentPlayerId && pendingVote !== null) {
        return { label: pendingVote ? "いる(仮)" : "いらない(仮)", confirmed: false };
      }

      return { label: "未回答", confirmed: false };
    },
    [currentPlayerId, gameState, pendingVote, voteState],
  );

  const fetchRoom = useCallback(async () => {
    const response = await fetch(`/api/rooms/${roomId}`, { method: "GET" });
    if (!response.ok) {
      throw new Error("部屋情報の取得に失敗しました");
    }
    const data = (await response.json()) as { room: Room };
    setRoom(data.room);
  }, [roomId]);

  const fetchPlayers = useCallback(async () => {
    const response = await fetch(`/api/rooms/${roomId}/players`, { method: "GET" });
    if (!response.ok) {
      throw new Error("プレイヤー一覧の取得に失敗しました");
    }
    const data = (await response.json()) as { players: Player[] };
    setPlayers(data.players ?? []);
  }, [roomId]);

  const fetchGameState = useCallback(async (viewerPlayerId?: string | null) => {
    const query = viewerPlayerId ? `?viewerPlayerId=${encodeURIComponent(viewerPlayerId)}` : "";
    const response = await fetch(`/api/rooms/${roomId}/game-state${query}`, { method: "GET" });
    if (!response.ok) {
      throw new Error("ゲーム状態の取得に失敗しました");
    }
    const data = (await response.json()) as {
      gameState: GameState;
      tableCardsHidden?: boolean;
      voteState?: VoteState;
      winner?: WinnerState | null;
    };
    setGameState(data.gameState);
    setTableCardsHidden(data.tableCardsHidden === true);
    setVoteState(data.voteState ?? null);
    setWinner(data.winner ?? null);
  }, [roomId]);

  const reloadGameData = useCallback(async (viewerPlayerId: string | null = currentPlayerId) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      await Promise.all([fetchRoom(), fetchPlayers(), fetchGameState(viewerPlayerId)]);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [currentPlayerId, fetchGameState, fetchPlayers, fetchRoom]);

  const onVoteTableCard = async (wantsCard: boolean) => {
    if (!currentPlayerId || room?.status !== "playing" || !voteState?.canVote || voteState.myVote !== null) {
      return;
    }
    setPendingVote(wantsCard);
  };

  const onConfirmVote = async () => {
    if (
      !currentPlayerId ||
      room?.status !== "playing" ||
      !voteState?.canVote ||
      voteState.myVote !== null ||
      pendingVote === null
    ) {
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/vote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: currentPlayerId,
          wantsCard: pendingVote,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "意思表示に失敗しました");
      }
      await reloadGameData(currentPlayerId);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onResolveTableCard = async (receiverPlayerId: string) => {
    if (!currentPlayerId || room?.status !== "playing" || !canResolveLocally) {
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/resolve-table-card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerId: currentPlayerId,
          receiverPlayerId,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "カード配布確定に失敗しました");
      }
      await reloadGameData(currentPlayerId);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onRematch = async () => {
    if (!currentPlayerId || room?.status !== "finished") {
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}/rematch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: currentPlayerId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "再戦の開始に失敗しました");
      }
      await reloadGameData(currentPlayerId);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const storedPlayerId = getStoredPlayerIdByRoom(roomId);
    setCurrentPlayerId(storedPlayerId);
    reloadGameData(storedPlayerId).catch((error) => {
      setErrorMessage(createErrorMessage(error));
    });
  }, [reloadGameData, roomId]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    const roomsChannel = supabase
      .channel(`room-realtime-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        () => {
          fetchRoom().catch((error) => setErrorMessage(createErrorMessage(error)));
        },
      )
      .subscribe();

    const playersChannel = supabase
      .channel(`players-realtime-game-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` },
        () => {
          fetchPlayers().catch((error) => setErrorMessage(createErrorMessage(error)));
        },
      )
      .subscribe();

    const gameStateChannel = supabase
      .channel(`game-state-realtime-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_states", filter: `room_id=eq.${roomId}` },
        () => {
          fetchGameState(currentPlayerId).catch((error) => setErrorMessage(createErrorMessage(error)));
        },
      )
      .subscribe();

    const cardVotesChannel = supabase
      .channel(`card-votes-realtime-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_votes", filter: `room_id=eq.${roomId}` },
        () => {
          fetchGameState(currentPlayerId).catch((error) => setErrorMessage(createErrorMessage(error)));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(roomsChannel);
      void supabase.removeChannel(playersChannel);
      void supabase.removeChannel(gameStateChannel);
      void supabase.removeChannel(cardVotesChannel);
    };
  }, [currentPlayerId, fetchGameState, fetchPlayers, fetchRoom, roomId]);

  return (
    <div className="min-h-screen bg-zinc-50 py-12 dark:bg-zinc-950">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 md:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
            {room ? `${room.name} - ゲーム画面` : "ゲーム画面"}
          </h1>
          <button
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-600 dark:text-zinc-200"
            type="button"
            onClick={() => router.push("/")}
          >
            ロビーに戻る
          </button>
        </div>

        {errorMessage && (
          <p className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {errorMessage}
          </p>
        )}

        {room?.status !== "playing" && room?.status !== "finished" && (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            この部屋は現在プレイ中ではありません。ロビーから開始してください。
          </div>
        )}

        {!isCurrentPlayerInRoom && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            このブラウザはこの部屋の参加プレイヤーとして登録されていません。ロビーで参加してから入室してください。
          </div>
        )}

        {(room?.status === "playing" || room?.status === "finished") && isCurrentPlayerInRoom && (
          <section className="grid gap-6 md:grid-cols-2">
            {winner && (
              <div className="relative overflow-hidden rounded-xl border border-amber-300 bg-gradient-to-r from-amber-100 via-yellow-50 to-orange-100 p-6 md:col-span-2 dark:border-amber-700 dark:from-amber-950/50 dark:via-zinc-900 dark:to-orange-950/40">
                <div className="pointer-events-none absolute -right-6 -top-6 text-7xl opacity-20">🏆</div>
                <div className="pointer-events-none absolute -left-4 -bottom-4 text-6xl opacity-20">✨</div>
                <p className="text-sm font-semibold tracking-widest text-amber-700 dark:text-amber-300">
                  WINNER
                </p>
                <h2 className="mt-1 text-2xl font-extrabold text-amber-900 dark:text-amber-200">
                  {winner.playerName} が勝利！
                </h2>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  {winner.reason === "unique"
                    ? "5種類のカードを集めたので勝利です。"
                    : room?.status === "finished" && typeof winner.score === "number"
                      ? `数字合計 ${winner.score} 点で勝利しました。`
                      : `${winner.uniqueCardCount} 種類の数字カードを集めて勝利しました。`}
                </p>
                {room?.status === "finished" && (
                  <button
                    type="button"
                    className="mt-4 rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    onClick={() => {
                      onRematch().catch(() => undefined);
                    }}
                    disabled={loading}
                  >
                    再戦する
                  </button>
                )}
              </div>
            )}
            <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">ゲーム情報</h2>
              {gameState ? (
                <dl className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
                  <div className="flex justify-between gap-4">
                    <dt>ターン</dt>
                    <dd>{gameState.turn}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>現在の手番</dt>
                    <dd>{currentTurnPlayerName ?? "不明"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>山札</dt>
                    <dd>{gameState.draw_pile_count} 枚</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">ゲーム状態を読み込み中です...</p>
              )}
              {gameState && (
                <div className="mt-3">
                  <p className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">山札一覧（構成）</p>
                  <div className="space-y-2">
                    {sortedDrawPileComposition.length === 0 && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">山札は空です</p>
                    )}
                    {drawPileLowCards.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {drawPileLowCards.map(({ value, count }) => (
                          <div key={`draw-composition-low-${value}`} className="relative">
                            <Card value={value} isBomb={false} />
                            <span className="absolute -bottom-2 -right-2 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white dark:bg-zinc-100 dark:text-zinc-900">
                              x{count}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {drawPileHighCards.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        {drawPileHighCards.map(({ value, count }) => (
                          <div key={`draw-composition-high-${value}`} className="relative">
                            <Card value={value} isBomb bombNumber={value} />
                            <span className="absolute -bottom-2 -right-2 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white dark:bg-zinc-100 dark:text-zinc-900">
                              x{count}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {gameState && (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">場のカード</h3>
                  <div className="flex flex-wrap gap-2">
                    {gameState.table_cards.map((cardValue, index) =>
                      typeof cardValue === "number" ? (
                        <Card key={`table-card-${index}`} value={cardValue} isBomb={false} />
                      ) : (
                        <div
                          key={`table-card-hidden-${index}`}
                          className="flex h-16 w-12 items-center justify-center rounded-lg border-2 border-slate-300 bg-slate-200 text-xl font-bold text-slate-600"
                        >
                          ?
                        </div>
                      ),
                    )}
                  </div>
                  {tableCardsHidden && (
                    <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                      あなたの手番中は場のカードを非表示にしています。
                    </p>
                  )}
                </div>
              )}

              {voteState && (
                <div className="mt-5 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">意思表示状況</p>
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                    回答 {voteState.submittedCount} / {voteState.totalVoters}
                  </p>

                  {room?.status === "playing" && voteState.canVote && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className={`rounded-md border-2 px-3 py-1 font-medium text-white ${
                          (voteState.myVote ?? pendingVote) === true
                            ? "border-blue-500 bg-emerald-600"
                            : "border-transparent bg-emerald-500"
                        }`}
                        onClick={() => {
                          onVoteTableCard(true).catch(() => undefined);
                        }}
                        disabled={loading || voteState.myVote !== null}
                      >
                        いる
                      </button>
                      <button
                        type="button"
                        className={`rounded-md border-2 px-3 py-1 font-medium text-white ${
                          (voteState.myVote ?? pendingVote) === false
                            ? "border-blue-500 bg-zinc-700"
                            : "border-transparent bg-zinc-600"
                        }`}
                        onClick={() => {
                          onVoteTableCard(false).catch(() => undefined);
                        }}
                        disabled={loading || voteState.myVote !== null}
                      >
                        いらない
                      </button>
                      <button
                        type="button"
                        className="rounded-md border-2 border-blue-600 bg-blue-600 px-3 py-1 font-medium text-white disabled:opacity-50"
                        onClick={() => {
                          onConfirmVote().catch(() => undefined);
                        }}
                        disabled={loading || voteState.myVote !== null || pendingVote === null}
                      >
                        確定
                      </button>
                    </div>
                  )}

                  {room?.status === "playing" && voteState.canVote && voteState.myVote !== null && (
                    <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                      意思表示は確定済みです。このターンでは変更できません。
                    </p>
                  )}

                  {room?.status === "playing" && !voteState.canVote && !canResolveLocally && (
                    <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
                      {voteState.allVotesSubmitted
                        ? "手番プレイヤーの配布決定を待っています。"
                        : "他プレイヤーの回答を待っています。"}
                    </p>
                  )}

                  {room?.status === "playing" && canResolveLocally && (
                    <div className="mt-3">
                      <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
                        手番プレイヤー: カードの受取先を選択してください
                        {voteState.forcedAllNeed ? "（全員いらないだったため全員候補）" : ""}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {eligibleReceivers.map((receiver) => (
                          <button
                            key={receiver.id}
                            type="button"
                            className="rounded-md bg-blue-600 px-3 py-1 text-white"
                            onClick={() => {
                              onResolveTableCard(receiver.id).catch(() => undefined);
                            }}
                            disabled={loading}
                          >
                            {receiver.name}
                            {receiver.id === currentPlayerId ? "（自分）" : ""}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">プレイヤー配置</h2>
              <div className="relative mx-auto h-[560px] max-w-[620px]">
                {otherPlayers.map((player, index) => {
                  const position = otherPlayerPositions[index] ?? { left: 50, top: 18 };
                  const vote = getVotePresentation(player.id);
                  return (
                    <div
                      key={player.id}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 ${otherPlayerZoneWidthClass}`}
                      style={{ left: `${position.left}%`, top: `${position.top}%` }}
                    >
                      <PlayerZone
                        player={{
                          id: player.id,
                          name: player.name,
                          collected_cards: player.collected_cards ?? [],
                          bombs: player.bombs ?? 0,
                        }}
                        isCurrentTurn={player.id === gameState?.current_player_id}
                        voteLabel={vote.label}
                        isVoteConfirmed={vote.confirmed}
                      />
                    </div>
                  );
                })}

                {selfPlayer && (
                  <div className="absolute left-1/2 top-[84%] w-[240px] -translate-x-1/2 -translate-y-1/2">
                    {(() => {
                      const vote = getVotePresentation(selfPlayer.id);
                      return (
                        <PlayerZone
                          player={{
                            id: selfPlayer.id,
                            name: `${selfPlayer.name}（あなた）`,
                            collected_cards: selfPlayer.collected_cards ?? [],
                            bombs: selfPlayer.bombs ?? 0,
                          }}
                          isCurrentTurn={selfPlayer.id === gameState?.current_player_id}
                          voteLabel={vote.label}
                          isVoteConfirmed={vote.confirmed}
                        />
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-6 md:col-span-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">イベントログ</h2>
                <button
                  className="rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-60 dark:border-zinc-600"
                  type="button"
                  onClick={() => {
                    reloadGameData().catch((error) => setErrorMessage(createErrorMessage(error)));
                  }}
                  disabled={loading}
                >
                  再読み込み
                </button>
              </div>
              {gameState && gameState.event_log.length > 0 ? (
                <ul className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
                  {gameState.event_log.map((log, index) => (
                    <li key={`${index}-${log}`}>- {log}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">まだログはありません</p>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
