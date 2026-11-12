/**
 * The Ask AI identity mark: an original eight-point starburst (alternating long and short rays
 * with round caps), drawn here and inspired by, not copied from, any vendor logo. It takes its
 * colour from `currentColor`, so callers set it with a text colour class.
 */
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI) / 4;
  const inner = 3.6;
  const outer = i % 2 === 0 ? 10.4 : 8;
  const at = (r: number) => [12 + r * Math.sin(angle), 12 - r * Math.cos(angle)] as const;
  const [x1, y1] = at(inner);
  const [x2, y2] = at(outer);
  return { x1, y1, x2, y2 };
});

export function StarburstMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {RAYS.map((r, i) => (
        <line
          key={i}
          x1={r.x1.toFixed(2)}
          y1={r.y1.toFixed(2)}
          x2={r.x2.toFixed(2)}
          y2={r.y2.toFixed(2)}
        />
      ))}
    </svg>
  );
}
