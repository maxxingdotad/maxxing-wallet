/**
 * Pieces of the confirm screens: the recipient's avatar and the big amount. One focal
 * number, quiet labels, one white button (styles.css, "Confirm screens").
 */

/** A round avatar drawn from the address itself: two colours and an angle from its characters, so the same address always
    looks the same and a different one looks different at a glance. No image is fetched. */
export function AddressAvatar({ address, size = 56 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (const c of address.toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const a = h % 360, b = (a + 70 + ((h >>> 9) % 120)) % 360, angle = (h >>> 17) % 360;
  return <span className="addr-avatar" aria-hidden="true" style={{ width: size, height: size,
    background: `conic-gradient(from ${angle}deg, hsl(${a} 70% 62%), hsl(${b} 75% 58%), hsl(${a} 70% 62%))` }} />;
}

/** The amount, large: whole part bright, the decimals dimmed, the symbol small after it. */
export function BigAmount({ value, symbol }: { value: string; symbol: string }) {
  const [whole, frac] = value.split(".");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Long amounts step down in size so they stay on one line in the popup.
  const length = grouped.length + (frac ? frac.length + 1 : 0);
  const fontSize = length > 12 ? 30 : length > 9 ? 38 : length > 7 ? 44 : 52;
  return <div className="big-amount num" style={{ fontSize }} aria-label={`${value} ${symbol}`}>
    <span>{grouped}</span>{frac ? <span className="frac">.{frac}</span> : null}<span className="sym">{symbol}</span>
  </div>;
}

