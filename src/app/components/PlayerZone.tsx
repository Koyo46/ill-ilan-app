import { Card } from './Card';

type Player = {
  id: string;
  name: string;
  collected_cards: number[];
  bombs: number;
};

export const PlayerZone = ({ player, isCurrentTurn }: { player: Player; isCurrentTurn: boolean }) => {
  return (
    <div className={`p-4 rounded-xl border-2 ${isCurrentTurn ? 'border-yellow-400 bg-yellow-50/50' : 'border-transparent'}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center">
          {player.name[0]}
        </div>
        <span className="font-semibold">{player.name}</span>
        {/* 爆弾数をアイコンで表示 */}
        <div className="flex gap-1 ml-auto">
          {[...Array(player.bombs)].map((_, i) => (
            <span key={i}>💣</span>
          ))}
        </div>
      </div>

      {/* 獲得カードリスト */}
      <div className="flex flex-wrap gap-2">
        {player.collected_cards.map((cardValue, index) => (
          <Card 
            key={`${player.id}-${index}`} 
            value={cardValue} 
            // 同じ数字が他にもあれば爆弾として表示する簡易ロジック
            isBomb={player.collected_cards.filter(v => v === cardValue).length > 1} 
          />
        ))}
      </div>
    </div>
  );
};