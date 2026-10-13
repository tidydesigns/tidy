export const rasterShapeFixtures = [
  {
    id: "app-icon",
    name: "Leaf icon",
    maxShapes: 3,
    body: '<rect x="145" y="25" width="334" height="334" rx="82" fill="#087f68"/><path d="M220 262C200 130 310 70 416 100C430 230 323 280 220 262Z" fill="#fff1d0"/><path d="M224 261L371 143" stroke="#087f68" stroke-width="16" stroke-linecap="round"/><circle cx="429" cy="302" r="14" fill="#f2b642"/>',
  },
  {
    id: "illustration",
    name: "House illustration",
    maxShapes: 11,
    body: '<rect x="28" y="29" width="568" height="322" rx="24" fill="#ece8dc"/><circle cx="115" cy="104" r="39" fill="#e9b348"/><path d="M45 320L199 113L322 320Z" fill="#71a896"/><path d="M223 320L419 85L579 320Z" fill="#337d74"/><rect x="242" y="153" width="141" height="168" rx="12" fill="#fcf8ee"/><path d="M226 158L312 92L399 158Z" fill="#dd704e"/><rect x="285" y="232" width="56" height="89" rx="4" fill="#415c6e"/><rect x="270" y="177" width="34" height="29" fill="#96c4ce"/><rect x="322" y="177" width="34" height="29" fill="#96c4ce"/><path d="M272 192H302M339 179V204" stroke="#fcf8ee" stroke-width="3"/>',
  },
  {
    id: "line-art",
    name: "Architectural line drawing",
    maxShapes: 3,
    body: '<g fill="none" stroke="#17272b" stroke-width="3" stroke-linejoin="round"><path d="M100 175L312 40L524 175M128 157V330H496V157M130 175H494M266 330V228H355V330"/><rect x="165" y="212" width="62" height="65"/><path d="M196 212V277M165 244H227"/><rect x="393" y="212" width="62" height="65"/><path d="M424 212V277M393 244H455M85 332H540"/></g>',
  },
] as const;

export const rasterShapeSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380" viewBox="0 0 624 380">${body}</svg>`;

export const generalRasterFixtures = [
  {
    id: "rotated-shapes",
    name: "Rotated geometry",
    expectedShapes: 3,
    body: '<rect x="50" y="90" width="145" height="160" transform="rotate(27 122.5 170)" fill="#087f68"/><ellipse cx="330" cy="175" rx="96" ry="49" transform="rotate(-31 330 175)" fill="#ee5b32"/><rect x="473" y="93" width="105" height="161" rx="24" transform="rotate(19 525 174)" fill="#f2b642"/>',
  },
  {
    id: "concave-shapes",
    name: "Concave shapes",
    expectedShapes: 3,
    body: '<path d="M110 80L131 144L199 144L144 184L165 249L110 209L55 249L76 184L21 144L89 144Z" fill="#087f68"/><path d="M250 120H325V75L410 175L325 275V230H250Z" fill="#ee5b32"/><path d="M520 265C375 173 460 66 520 133C582 65 665 172 520 265Z" fill="#415c6e"/>',
  },
  {
    id: "linear-gradient",
    name: "Editable linear gradient",
    expectedShapes: 1,
    body: '<defs><linearGradient id="g"><stop stop-color="#e34d62"/><stop offset="1" stop-color="#347dcc"/></linearGradient></defs><ellipse cx="312" cy="190" rx="230" ry="135" fill="url(#g)"/>',
  },
  {
    id: "many-colours",
    name: "Twenty distinct colours",
    expectedShapes: 20,
    body: Array.from(
      { length: 20 },
      (_, i) =>
        `<rect x="${32 + (i % 5) * 116}" y="${35 + Math.floor(i / 5) * 80}" width="84" height="52" rx="8" fill="hsl(${i * 18} 65% 55%)"/>`,
    ).join(""),
  },
  {
    id: "close-colours",
    name: "Close shades and a small accent",
    expectedShapes: 3,
    body: '<rect x="55" y="75" width="250" height="220" rx="25" fill="#8ab2be"/><rect x="319" y="75" width="250" height="220" rx="25" fill="#94bac6"/><circle cx="312" cy="335" r="5" fill="#ee5b32"/>',
  },
  {
    id: "thin-cutout",
    name: "Thin intentional cutout",
    expectedShapes: 1,
    body: '<path fill="#087f68" fill-rule="evenodd" d="M70 45H550V335H70ZM115 105V275H500V105ZM90 55H93V320H90Z"/>',
  },
] as const;
