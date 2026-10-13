// One shared drawing keeps all six slices and the final hero slice consistent.
const otherSlices = [60, 120, 180, 240, 300].map(angle =>
  `<use class="pizza-piece" href="#hero-pizza-piece" transform="translate(52 52) rotate(${angle}) translate(0 -1.5) scale(.73) translate(-32 -58)"/>`
).join('');

export const heroPizza = `<span class="hero-pizza" aria-hidden="true">
  <svg class="pizza-scene" viewBox="0 0 104 104" focusable="false">
    <defs>
      <g id="hero-pizza-piece">
        <path d="M11 14Q32 1 53 14L32 58Z" fill="#f8bd50" stroke="#342c24" stroke-width="3" stroke-linejoin="round"/>
        <path d="M11 14Q32 1 53 14" fill="none" stroke="#e66b35" stroke-width="8" stroke-linecap="round"/>
        <circle cx="25" cy="23" r="5" fill="#d64b32"/>
        <circle cx="39" cy="29" r="5" fill="#d64b32"/>
        <circle cx="30" cy="41" r="4" fill="#d64b32"/>
      </g>
    </defs>
    <g class="pizza-remaining">
      <rect x="6" y="8" width="92" height="92" rx="8" fill="#dfd1ba" opacity=".45"/>
      <rect x="5" y="5" width="94" height="94" rx="8" fill="#e9d3b2" stroke="#b99a72" stroke-width="1.4"/>
      <rect x="10" y="10" width="84" height="84" rx="5" fill="#fff4df" stroke="#d9bd94" stroke-width="1"/>
      <path d="m6 6 5 5m87-5-5 5M6 98l5-5m87 5-5-5" fill="none" stroke="#c6a780" stroke-width="1"/>
      <path d="M44 96h16" fill="none" stroke="#b99a72" stroke-width="1.5" stroke-linecap="round"/>
      ${otherSlices}
    </g>
    <g class="pizza-slice"><g transform="scale(1.625)"><use class="pizza-piece" href="#hero-pizza-piece"/></g></g>
    <g class="pizza-steam" fill="none" stroke="#af926c" stroke-width="1.7" stroke-linecap="round">
      <path d="M31 20c-6-6 5-10 0-16"/>
      <path d="M52 14c-7-7 6-12 0-19"/>
      <path d="M73 20c-6-6 5-10 0-16"/>
    </g>
    <g class="pizza-lid">
      <rect x="5" y="5" width="94" height="94" rx="8" fill="#f4e5cf" stroke="#b99a72" stroke-width="1.4"/>
      <rect x="10" y="10" width="84" height="84" rx="5" fill="none" stroke="#dfc6a3" stroke-width=".9"/>
      <g fill="none" stroke="#d08d5b" stroke-width="1.6" opacity=".75">
        <circle cx="52" cy="52" r="16"/>
        <path d="M52 36v32M38.14 44l27.72 16M38.14 60l27.72-16"/>
        <path d="M43 27h18m-18 50h18" stroke="#ceb08a" stroke-width="1" stroke-linecap="round"/>
      </g>
      <path d="M45 97h14" fill="none" stroke="#b99a72" stroke-width="1.5" stroke-linecap="round"/>
    </g>
  </svg>
</span>`;
