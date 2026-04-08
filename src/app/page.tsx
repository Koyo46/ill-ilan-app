"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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
};

type RoomsResponse = {
  rooms: Room[];
};

type PlayersResponse = {
  players: Player[];
};

const PLAYER_ID_STORAGE_KEY = "ill-ilan-player-ids-by-room";

const getStoredPlayerIdsByRoom = () => {
  if (typeof window === "undefined") {
    return {} as Record<string, string>;
  }

  const raw = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
  if (!raw) {
    return {} as Record<string, string>;
  }

  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
};

const setStoredPlayerId = (roomId: string, playerId: string) => {
  const map = getStoredPlayerIdsByRoom();
  map[roomId] = playerId;
  window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, JSON.stringify(map));
};

const removeStoredPlayerId = (roomId: string) => {
  const map = getStoredPlayerIdsByRoom();
  delete map[roomId];
  window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, JSON.stringify(map));
};

const createErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return "予期せぬエラーが発生しました";
};

export default function Home() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [joinPlayerName, setJoinPlayerName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) ?? null,
    [rooms, selectedRoomId],
  );
  const isCurrentPlayerInSelectedRoom = useMemo(
    () => (currentPlayerId ? players.some((player) => player.id === currentPlayerId) : false),
    [currentPlayerId, players],
  );
  const isCurrentPlayerHostInSelectedRoom = useMemo(
    () => (currentPlayerId ? players.some((player) => player.id === currentPlayerId && player.is_host) : false),
    [currentPlayerId, players],
  );
  const fetchRooms = useCallback(async () => {
    const response = await fetch("/api/rooms", { method: "GET" });
    if (!response.ok) {
      throw new Error("部屋一覧の取得に失敗しました");
    }
    const data = (await response.json()) as RoomsResponse;
    setRooms(data.rooms ?? []);
  }, []);

  const fetchPlayers = useCallback(async (roomId: string) => {
    const response = await fetch(`/api/rooms/${roomId}/players`, { method: "GET" });
    if (!response.ok) {
      throw new Error("プレイヤー一覧の取得に失敗しました");
    }
    const data = (await response.json()) as PlayersResponse;
    setPlayers(data.players ?? []);
  }, []);

  useEffect(() => {
    fetchRooms().catch((error) => setErrorMessage(createErrorMessage(error)));
  }, [fetchRooms]);

  useEffect(() => {
    if (!selectedRoomId) {
      setPlayers([]);
      setCurrentPlayerId(null);
      return;
    }

    const storedPlayerIds = getStoredPlayerIdsByRoom();
    setCurrentPlayerId(storedPlayerIds[selectedRoomId] ?? null);

    fetchPlayers(selectedRoomId).catch((error) => {
      setErrorMessage(createErrorMessage(error));
    });
  }, [fetchPlayers, selectedRoomId]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    const roomsChannel = supabase
      .channel("rooms-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, () => {
        fetchRooms().catch((error) => setErrorMessage(createErrorMessage(error)));
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(roomsChannel);
    };
  }, [fetchRooms]);

  useEffect(() => {
    if (!selectedRoomId) {
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const playersChannel = supabase
      .channel(`players-realtime-${selectedRoomId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `room_id=eq.${selectedRoomId}`,
        },
        () => {
          fetchPlayers(selectedRoomId).catch((error) =>
            setErrorMessage(createErrorMessage(error)),
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(playersChannel);
    };
  }, [fetchPlayers, selectedRoomId]);

  const onCreateRoom: React.FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomName,
          playerName,
          maxPlayers,
        }),
      });

      const payload = (await response.json()) as
        | { error: string }
        | { room: Room; hostPlayer: Player };

      if (!response.ok || "error" in payload) {
        throw new Error("error" in payload ? payload.error : "部屋作成に失敗しました");
      }

      setSelectedRoomId(payload.room.id);
      setRoomName("");
      setPlayerName("");
      setJoinPlayerName("");
      setCurrentPlayerId(payload.hostPlayer.id);
      setStoredPlayerId(payload.room.id, payload.hostPlayer.id);
      setPlayers([payload.hostPlayer]);
      await fetchRooms();
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onJoinRoom: React.FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    if (!selectedRoomId || isCurrentPlayerInSelectedRoom) {
      if (isCurrentPlayerInSelectedRoom) {
        setErrorMessage("この部屋にはすでに参加しています。離脱する場合は離脱ボタンを押してください。");
      }
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/rooms/${selectedRoomId}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playerName: joinPlayerName,
        }),
      });

      const payload = (await response.json()) as { error?: string; player?: Player };
      if (!response.ok) {
        throw new Error(payload.error ?? "部屋参加に失敗しました");
      }

      setJoinPlayerName("");
      if (payload.player?.id) {
        setCurrentPlayerId(payload.player.id);
        setStoredPlayerId(selectedRoomId, payload.player.id);
      }
      await fetchPlayers(selectedRoomId);
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onLeaveRoom = async () => {
    if (!selectedRoomId || !currentPlayerId || selectedRoom?.status === "playing") {
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/rooms/${selectedRoomId}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: currentPlayerId }),
      });

      const payload = (await response.json()) as { error?: string; roomDeleted?: boolean };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "部屋からの離脱に失敗しました");
      }

      setCurrentPlayerId(null);
      removeStoredPlayerId(selectedRoomId);
      setJoinPlayerName("");

      if (payload.roomDeleted === true) {
        setSelectedRoomId(null);
        setPlayers([]);
      } else {
        await fetchPlayers(selectedRoomId);
      }

      await fetchRooms();
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onDeleteRoom = async () => {
    if (
      !selectedRoomId ||
      !currentPlayerId ||
      !isCurrentPlayerHostInSelectedRoom ||
      selectedRoom?.status === "playing"
    ) {
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/rooms/${selectedRoomId}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: currentPlayerId }),
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? "部屋の削除に失敗しました");
      }

      removeStoredPlayerId(selectedRoomId);
      setCurrentPlayerId(null);
      setSelectedRoomId(null);
      setPlayers([]);
      setJoinPlayerName("");
      await fetchRooms();
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onStartGame = async () => {
    if (!selectedRoomId) {
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/rooms/${selectedRoomId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "ゲーム開始に失敗しました");
      }

      await fetchRooms();
    } catch (error) {
      setErrorMessage(createErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const onEnterGame = async () => {
    if (!selectedRoomId || !isCurrentPlayerInSelectedRoom) {
      return;
    }
    router.push(`/game/${selectedRoomId}`);
  };

  return (
    <div className="min-h-screen bg-zinc-50 py-12 dark:bg-zinc-950">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 md:px-8">
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">イルイラン ロビー</h1>

        {errorMessage && (
          <p className="rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {errorMessage}
          </p>
        )}

        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">部屋を作成</h2>
          <form className="grid gap-3 md:grid-cols-4" onSubmit={onCreateRoom}>
            <input
              className="rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              placeholder="部屋名"
              value={roomName}
              onChange={(event) => setRoomName(event.target.value)}
              required
            />
            <input
              className="rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              placeholder="ホスト名"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              required
            />
            <input
              className="rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              type="number"
              min={2}
              max={8}
              value={maxPlayers}
              onChange={(event) => setMaxPlayers(Number(event.target.value))}
              required
            />
            <button
              className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
              type="submit"
              disabled={loading}
            >
              作成して参加
            </button>
          </form>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">部屋一覧</h2>
            <ul className="space-y-2">
              {rooms.length === 0 && (
                <li className="text-sm text-zinc-500 dark:text-zinc-400">まだ部屋がありません</li>
              )}
              {rooms.map((room) => (
                <li
                  key={room.id}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 ${
                    selectedRoomId === room.id
                      ? "border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40"
                      : "border-zinc-200 dark:border-zinc-700"
                  }`}
                >
                  <button
                    className="text-left"
                    onClick={() => setSelectedRoomId(room.id)}
                    type="button"
                  >
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{room.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {room.status} / 最大 {room.max_players} 人
                    </p>
                  </button>
                  <button
                    className="rounded-md border border-zinc-300 px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-600"
                    type="button"
                    onClick={() => setSelectedRoomId(room.id)}
                  >
                    選択
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-4 text-xl font-semibold text-zinc-900 dark:text-zinc-100">選択中の部屋</h2>

            {!selectedRoom && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">部屋を選択してください</p>
            )}

            {selectedRoom && (
              <div className="space-y-4">
                <div>
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">{selectedRoom.name}</p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    状態: {selectedRoom.status}
                  </p>
                </div>

                <form className="flex gap-2" onSubmit={onJoinRoom}>
                  <input
                    className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    placeholder="参加プレイヤー名"
                    value={joinPlayerName}
                    onChange={(event) => setJoinPlayerName(event.target.value)}
                    required={!isCurrentPlayerInSelectedRoom}
                    disabled={isCurrentPlayerInSelectedRoom}
                  />
                  <button
                    className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
                    type="submit"
                    disabled={
                      loading || selectedRoom.status !== "waiting" || isCurrentPlayerInSelectedRoom
                    }
                  >
                    参加
                  </button>
                </form>
                {isCurrentPlayerInSelectedRoom && selectedRoom.status !== "playing" && (
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-md border border-rose-400 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 disabled:opacity-60 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                      type="button"
                      onClick={onLeaveRoom}
                      disabled={loading}
                    >
                      離脱
                    </button>
                    {isCurrentPlayerHostInSelectedRoom && (
                      <button
                        className="rounded-md border border-red-500 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-60 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                        type="button"
                        onClick={onDeleteRoom}
                        disabled={loading}
                      >
                        部屋を削除
                      </button>
                    )}
                  </div>
                )}

                <div>
                  <h3 className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">プレイヤー</h3>
                  <ul className="space-y-1">
                    {players.map((player) => (
                      <li
                        key={player.id}
                        className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-200"
                      >
                        <span className="inline-flex items-center gap-2">
                          {player.is_host && (
                            <span className="material-symbols-outlined text-amber-500">
                            crown
                            </span>
                          )}
                          <span>
                            {player.name}
                            {player.id === currentPlayerId ? "（あなた）" : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                    {players.length === 0 && (
                      <li className="text-sm text-zinc-500 dark:text-zinc-400">プレイヤーがいません</li>
                    )}
                  </ul>
                </div>

                <button
                  className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-60"
                  type="button"
                  onClick={selectedRoom.status === "waiting" ? onStartGame : onEnterGame}
                  disabled={
                    loading ||
                    (selectedRoom.status === "playing" && !isCurrentPlayerInSelectedRoom) ||
                    (selectedRoom.status !== "waiting" && selectedRoom.status !== "playing")
                  }
                >
                  {selectedRoom.status === "playing" ? "入室する" : "ゲーム開始"}
                </button>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
