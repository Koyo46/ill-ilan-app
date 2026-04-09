import type { ReactElement } from "react";
import { Card } from './Card';

type Player = {
  id: string;
  name: string;
  collected_cards: number[];
  bombs: number;
};

export const PlayerZone = ({
  player,
  isCurrentTurn,
  voteLabel,
  isVoteConfirmed = false,
}: {
  player: Player;
  isCurrentTurn: boolean;
  voteLabel?: string | null;
  isVoteConfirmed?: boolean;
}) => {
  const groupedCards = player.collected_cards.reduce<Array<{ value: number; count: number }>>((acc, value) => {
    const existing = acc.find((entry) => entry.value === value);
    if (existing) {
      existing.count += 1;
      return acc;
    }
    acc.push({ value, count: 1 });
    return acc;
  }, []);

  return (
    <div className={`p-4 rounded-xl border-2 ${isCurrentTurn ? 'border-yellow-400 bg-yellow-50/50' : 'border-transparent'}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center">
          {player.name[0]}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{player.name}</span>
          {voteLabel && (
            <span
              className={`rounded-md border-2 px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                isVoteConfirmed
                  ? "border-blue-500 text-blue-700"
                  : "border-zinc-300 text-zinc-600"
              }`}
            >
              {voteLabel}
            </span>
          )}
        </div>
        {/* 爆弾数をアイコンで表示 */}
        <div className="flex gap-1 ml-auto">
          {[...Array(player.bombs)].map((_, i) => (
            <span key={i}>💣</span>
          ))}
        </div>
      </div>

      {/* 獲得カードリスト */}
      <div className="flex flex-wrap gap-2">
        {groupedCards.flatMap(({ value, count }) => {
          if (value >= 10) {
            return Array.from({ length: count }).map((_, index) => (
              <Card key={`${player.id}-${value}-fixed-bomb-${index}`} value={value} isBomb bombNumber={value} />
            ));
          }

          const pairCount = Math.floor(count / 2);
          const remainder = count % 2;
          const items: ReactElement[] = [];

          for (let i = 0; i < pairCount; i += 1) {
            items.push(
              <div key={`${player.id}-${value}-bomb-${i}`} className="relative h-20 w-12">
                <div className="absolute left-0 top-0 h-16 w-12 rounded-lg border-2 border-red-400 bg-red-200/70" />
                <div className="absolute left-0 top-4">
                  <Card value={value} isBomb bombNumber={value} />
                </div>
              </div>,
            );
          }

          if (remainder === 1) {
            items.push(<Card key={`${player.id}-${value}-single`} value={value} isBomb={false} />);
          }

          return items;
        })}
      </div>
    </div>
  );
};