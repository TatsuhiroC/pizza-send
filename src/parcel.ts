const otherPieces = [60, 120, 180, 240, 300].map(angle =>
  `<use class="parcel-piece" href="#parcel-pizza-piece" transform="translate(52 52) rotate(${angle}) translate(0 -1.5) scale(.73) translate(-32 -58)"/>`
).join('');

// A single illustration stays in the headline slot throughout the transfer.
export const parcelHero = `<span class="hero-pizza parcel-hero" data-state="idle" aria-hidden="true">
  <svg class="parcel-scene" viewBox="0 0 104 104" focusable="false">
    <defs><g id="parcel-pizza-piece">
      <path d="M11 14Q32 1 53 14L32 58Z" fill="#f8bd50" stroke="#342c24" stroke-width="3" stroke-linejoin="round"/>
      <path d="M11 14Q32 1 53 14" fill="none" stroke="#e66b35" stroke-width="8" stroke-linecap="round"/>
      <circle cx="25" cy="23" r="5" fill="#d64b32"/><circle cx="39" cy="29" r="5" fill="#d64b32"/><circle cx="30" cy="41" r="4" fill="#d64b32"/>
    </g>
      <linearGradient id="parcel-wake-ink" x1="-26" y1="0" x2="46" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#e4b38b" stop-opacity="0"/><stop offset=".65" stop-color="#e4b38b" stop-opacity=".28"/><stop offset="1" stop-color="#dc9763" stop-opacity=".52"/></linearGradient>
    </defs>
    <g class="parcel-speed">
      <g class="parcel-wake" fill="url(#parcel-wake-ink)">
        <path d="M28 49C10 47-3 46-24 46v4c21 0 35 2 54 3Z"/>
        <path d="M37 64C16 62 1 63-24 64v5c23-2 41 0 63-1Z"/>
        <path d="M46 85C28 86 10 89-13 90v4c24-2 42-3 61-4Z"/>
      </g>
      <g class="parcel-echoes" fill="none" stroke="#c8a47a" stroke-width="1.2" stroke-linejoin="round">
        <path class="parcel-echo" d="M42 41.5456 75.84 65.47424 42 89.40288 8.16 65.47424Z"/>
        <path class="parcel-echo parcel-echo-far" d="M42 41.5456 75.84 65.47424 42 89.40288 8.16 65.47424Z"/>
      </g>
      <g class="parcel-trails" fill="none" stroke="#cc9366" stroke-width="1.5" stroke-linecap="round">
        <path d="M-26 28H102"/><path d="M-25 39H118"/><path d="M-27 54H126"/><path d="M-25 68H123"/>
        <path d="M-24 83H119"/><path d="M-22 99H111"/><path d="M-17 108H101"/>
        <path class="parcel-trail-fine" d="M-17 19H94"/><path class="parcel-trail-fine" d="M-24 46H127"/><path class="parcel-trail-fine" d="M-16 92H118"/>
      </g>
    </g>
    <g class="parcel-box">
      <path d="m42 42 34 24-34 26L8 67Z" fill="#ded2bd" opacity=".4"/>
      <g transform="matrix(.36 .25456 -.36 .25456 42 39)">
        <rect x="5" y="5" width="94" height="94" rx="6" fill="#e9d3b2" stroke="#b99a72" stroke-width="1.5"/>
        <rect x="10" y="10" width="84" height="84" rx="4" fill="#fff4df" stroke="#d9bd94" stroke-width="1"/>
        <path d="m6 6 5 5m87-5-5 5M6 98l5-5m87 5-5-5" fill="none" stroke="#c6a780" stroke-width="1"/>
        ${otherPieces}
      </g>
    </g>
    <g class="parcel-loose-slice"><g transform="scale(1.625)"><use class="parcel-piece" href="#parcel-pizza-piece"/></g></g>
    <g class="parcel-box parcel-rim" stroke="#b99a72" stroke-width="1.1" stroke-linejoin="round">
      <path d="M8.16 65.47424 42 89.40288v5L8.16 70.47424Z" fill="#dcb98a"/>
      <path d="M42 89.40288 75.84 65.47424v5L42 94.40288Z" fill="#e6c79e"/>
      <path d="m53 82 8-5.66v2.5L53 84.5Z" fill="#d49362" stroke="none"/>
    </g>
    <g class="parcel-box parcel-lid-wrap"><g class="parcel-lid-face">
      <rect x="5" y="5" width="94" height="94" rx="6" fill="#f4e5cf" stroke="#b99a72" stroke-width="1.5"/>
      <rect x="11" y="11" width="82" height="82" rx="3" fill="#faedd9" stroke="#dfc6a3" stroke-width="1"/>
      <g fill="none" stroke="#d08d5b" stroke-width="1.7" opacity=".75"><circle cx="52" cy="52" r="16"/><path d="M52 36v32M38.14 44l27.72 16M38.14 60l27.72-16"/></g>
      <path d="M43 24h18m-18 56h18" fill="none" stroke="#d1b28c" stroke-width="1" stroke-linecap="round"/>
    </g></g>
    <g class="parcel-steam" fill="none" stroke="#af926c" stroke-width="1.5" stroke-linecap="round">
      <path d="M26 54c-6-6 5-10 0-16"/><path d="M40 49c-6-6 5-10 0-16"/><path d="M52 58c-6-6 5-10 0-16"/>
    </g>
  </svg>
</span>`;
