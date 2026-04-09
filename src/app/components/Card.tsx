export const Card = ({
  value,
  isBomb,
  bombNumber,
}: {
  value: number;
  isBomb: boolean;
  bombNumber?: number;
}) => (
  <div
    className={`
      relative h-16 w-12 rounded-lg border-2 shadow-sm
      flex items-center justify-center font-bold text-xl
      ${isBomb ? "animate-pulse border-red-700 bg-red-500 text-white" : "border-slate-300 bg-white text-slate-800"}
    `}
  >
    {isBomb ? "💣" : value}
    {isBomb && typeof bombNumber === "number" && (
      <span className="absolute right-1 top-0.5 text-[10px] font-semibold leading-none text-white/90">
        {bombNumber}
      </span>
    )}
  </div>
);