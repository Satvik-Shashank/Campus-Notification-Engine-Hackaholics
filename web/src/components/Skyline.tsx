/**
 * Hand-drawn monoline campus skyline: clock tower, arched main block, library dome, trees.
 * Pure SVG strokes in the current text colour, so it themes with light and dark.
 */
export function Skyline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 220" preserveAspectRatio="xMidYMax slice" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {/* ground */}
      <path d="M0 210 H1200" />
      {/* trees left */}
      <path d="M40 210 V180 M40 182 c-14 -4 -18 -22 -6 -30 c-2 -14 16 -20 22 -8 c14 -2 18 18 6 26 c4 10 -10 16 -22 12" />
      <path d="M92 210 V188 M92 190 c-10 -2 -12 -16 -2 -20 c2 -10 16 -10 16 2 c10 4 6 18 -4 18" />
      {/* hostel block */}
      <path d="M130 210 V120 H270 V210 M130 120 L200 96 L270 120" />
      {[146, 176, 206, 236].map((x) => [136, 162, 188].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="14" height="16" rx="1" />))}
      {/* clock tower */}
      <path d="M318 210 V80 H370 V210 M318 80 L344 40 L370 80 M344 40 V24 M336 30 H352" />
      <circle cx="344" cy="104" r="14" /><path d="M344 104 V95 M344 104 L351 108" />
      <path d="M330 140 H358 M330 170 H358" /><path d="M336 210 V188 a8 8 0 0 1 16 0 V210" />
      {/* main academic block with arches */}
      <path d="M380 210 V110 H640 V210 M380 110 L380 98 H640 V110 M372 98 H648" />
      {[396, 446, 496, 546, 596].map((x) => <path key={x} d={`M${x} 210 V170 a14 14 0 0 1 28 0 V210`} />)}
      {[396, 446, 496, 546, 596].map((x) => <path key={`w${x}`} d={`M${x + 4} 150 V126 H${x + 24} V150 Z`} />)}
      <path d="M470 98 L510 72 L550 98" /><path d="M505 86 H515" />
      {/* library dome */}
      <path d="M680 210 V140 H820 V210 M680 140 H820 M694 140 a56 56 0 0 1 112 0 M750 84 V70 M745 74 H755" />
      {[700, 730, 760, 790].map((x) => <path key={x} d={`M${x} 210 V156`} />)}
      <path d="M690 156 H810" />
      {/* modern block */}
      <path d="M850 210 V100 H960 V210 M850 100 L960 88" />
      {[118, 140, 162, 184].map((y) => <path key={y} d={`M862 ${y} H948`} />)}
      <path d="M905 100 V210" />
      {/* trees right */}
      <path d="M1000 210 V176 M1000 178 c-16 -2 -20 -24 -6 -32 c0 -16 22 -20 26 -4 c14 4 12 26 -2 30 c-4 6 -12 8 -18 6" />
      <path d="M1046 210 V186 M1046 188 c-12 0 -14 -18 -2 -22 c4 -12 20 -8 18 4 c8 6 2 18 -8 18" />
      {/* auditorium */}
      <path d="M1080 210 V150 Q1135 112 1190 150 V210 M1080 150 H1190" />
      <path d="M1112 210 V176 H1158 V210" />
      {/* birds */}
      <path d="M560 40 q6 -6 12 0 q6 -6 12 0 M610 26 q5 -5 10 0 q5 -5 10 0 M240 50 q5 -5 10 0 q5 -5 10 0" />
    </svg>
  );
}
