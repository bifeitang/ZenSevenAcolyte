// pin-gate.js — PIN 驗證（DESIGN.md 3.2）。
//
// 換 PIN 方式：在瀏覽器 console 執行
//   await crypto.subtle.digest('SHA-256', new TextEncoder().encode('<新PIN>'))
//     .then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join(''))
// 把印出的 64 碼 hex 貼到下方 PIN_HASH 常數即可。

// sha256 of "0718"
export const PIN_HASH =
  "77416e17bdbf5cf590c297eb78f7a8f226d9a0fa5774b6d18708b2ca5a56e0cd";

const STORAGE_KEY = "chan7.unlocked";

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {string} input
 * @returns {Promise<boolean>}
 */
export async function checkPin(input) {
  const hash = await sha256Hex(input);
  return hash === PIN_HASH;
}

/** @returns {boolean} */
export function isUnlocked() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setUnlocked() {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* localStorage 不可用時（隱私模式等）忽略，維持每次都需輸入 PIN */
  }
}
