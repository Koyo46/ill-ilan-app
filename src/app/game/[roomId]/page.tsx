"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
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
  draw_pile: unknown[];
  discard_pile: unknown[];
  table_cards: unknown[];
  event_log: string[];
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

  const currentTurnPlayerName = useMemo(() => {
    if (!gameState?.current_player_id) {
      return null;
    }
    return players.find((player) => player.id === gameState.current_player_id)?.name ?? null;
  }, [gameState?.current_player_id, players]);

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

  const fetchGameState = useCallback(async () => {
    const response = await fetch(`/api/rooms/${roomId}/game-state`, { method: "GET" });
    if (!response.ok) {
      throw new Error("ゲーム状態の取得に失敗しました");
    }
    const data = (await response.json()) as { gameState: GameState };
    setGameState(data.gameState);
  }, [roomId]);

  const reloadGameData = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      await Promise.all([fetchRoom(), fetchPlayers(), fetchGameState()]);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [fetchGameState, fetchPlayers, fetchRoom]);

  useEffect(() => {
    setCurrentPlayerId(getStoredPlayerIdByRoom(roomId));
    reloadGameData().catch((error) => {
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
          fetchGameState().catch((error) => setErrorMessage(createErrorMessage(error)));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(roomsChannel);
      void supabase.removeChannel(playersChannel);
      void supabase.removeChannel(gameStateChannel);
    };
  }, [fetchGameState, fetchPlayers, fetchRoom, roomId]);

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

        {room?.status !== "playing" && (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            この部屋は現在プレイ中ではありません。ロビーから開始してください。
          </div>
        )}

        {!isCurrentPlayerInRoom && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            このブラウザはこの部屋の参加プレイヤーとして登録されていません。ロビーで参加してから入室してください。
          </div>
        )}

        {room?.status === "playing" && isCurrentPlayerInRoom && (
          <section className="grid gap-6 md:grid-cols-2">
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
                    <dd>{gameState.draw_pile.length} 枚</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>捨て札</dt>
                    <dd>{gameState.discard_pile.length} 枚</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>場のカード</dt>
                    <dd>{gameState.table_cards.length} 枚</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">ゲーム状態を読み込み中です...</p>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">プレイヤー配置</h2>
              <div className="relative mx-auto h-[520px] max-w-[520px]">
                {otherPlayers.map((player, index) => {
                  const count = otherPlayers.length;
                  const angleDeg = count === 1 ? -90 : -90 + (180 / (count - 1)) * index;
                  const angleRad = (angleDeg * Math.PI) / 180;
                  const radius = 190;
                  const centerX = 260;
                  const centerY = 230;
                  const x = centerX + Math.cos(angleRad) * radius;
                  const y = centerY + Math.sin(angleRad) * radius;

                  return (
                    <div
                      key={player.id}
                      className="absolute w-[220px] -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${x}px`, top: `${y}px` }}
                    >
                      <PlayerZone
                        player={{
                          id: player.id,
                          name: `${player.name}${player.id === gameState?.current_player_id ? "（手番）" : ""}`,
                          collected_cards: player.collected_cards ?? [],
                          bombs: player.bombs ?? 0,
                        }}
                        isCurrentTurn={player.id === gameState?.current_player_id}
                      />
                    </div>
                  );
                })}

                {selfPlayer && (
                  <div className="absolute bottom-0 left-1/2 w-[260px] -translate-x-1/2">
                    <PlayerZone
                      player={{
                        id: selfPlayer.id,
                        name: `${selfPlayer.name}（あなた）${selfPlayer.id === gameState?.current_player_id ? "（手番）" : ""}`,
                        collected_cards: selfPlayer.collected_cards ?? [],
                        bombs: selfPlayer.bombs ?? 0,
                      }}
                      isCurrentTurn={selfPlayer.id === gameState?.current_player_id}
                    />
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
