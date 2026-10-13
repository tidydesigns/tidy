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
