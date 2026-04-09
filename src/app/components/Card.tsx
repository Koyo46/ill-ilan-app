export const Card = ({ value, isBomb }: { value: number; isBomb: boolean }) => (
  <div className={`
    w-12 h-16 rounded-lg border-2 flex items-center justify-center font-bold text-xl shadow-sm
    ${isBomb ? 'bg-red-500 border-red-700 text-white animate-pulse' : 'bg-white border-slate-300 text-slate-800'}
  `}>
    {isBomb ? '💣' : value}
  </div>
);