export const generateInitialDeck = (): number[] => {
  const deck: number[] = [];

  // 2が2枚、3が3枚 ... 8が8枚 を生成
  for (let n = 2; n <= 8; n += 1) {
    for (let i = 0; i < n; i += 1) {
      deck.push(n);
    }
  }

  // 10, 11, 12, 13 を各1枚追加
  deck.push(10, 11, 12, 13);

  // Fisher-Yates アルゴリズムでシャッフル
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }

  return deck;
};
