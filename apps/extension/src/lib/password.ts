/**
 * The rules for the one password, applied where it's chosen (first run, change). At least 8 characters, or at least 6 if it's
 * digits only; at most 128. The ones people guess first are refused with a plain reason: one character repeated, a straight run of
 * digits, a repeated short pattern, and the most used codes and words. A wrong try never makes the next one wait.
 */
export const PASSWORD_RULE = "At least 8 characters, or 6 or more digits. Avoid runs, repeats and dates.";

const COMMON_DIGITS = new Set(["123123", "121212", "112233", "123321", "654321", "123456", "111222", "102030", "696969", "159753", "147258", "789456", "12345678", "11223344", "87654321"]);
const COMMON_WORDS = new Set(["password", "password1", "passw0rd", "qwertyui", "qwerty123", "iloveyou", "abc12345", "abcd1234", "maxxing1", "maxxingwallet", "letmein1", "welcome1", "11111111a", "a1234567"]);

export function weakPassword(password: string): string | null {
  const chars = [...password];
  if (chars.length > 128) return "Use at most 128 characters.";
  const digitsOnly = /^\d+$/.test(password);
  if (digitsOnly ? chars.length < 6 : chars.length < 8) return digitsOnly ? "Use at least 6 digits." : "Use at least 8 characters.";
  if (chars.every(c => c === chars[0])) return "One character over and over is the first thing anyone tries. Mix them.";
  if (digitsOnly) {
    // A run up or down, also when it wraps past 9 (1234567890).
    const d = chars.map(Number), step = (d[1]! - d[0]! + 10) % 10;
    if ((step === 1 || step === 9) && d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === step)) return "A straight run like 123456 is easy to guess. Mix the digits.";
  }
  for (const period of [2, 3, 4]) if (chars.length % period === 0 && chars.length > period && password.slice(0, period).repeat(chars.length / period) === password) return "A repeated pattern is easy to guess. Mix it up.";
  if (COMMON_DIGITS.has(password) || COMMON_WORDS.has(password.toLowerCase())) return "That's one of the most used passwords. Choose another.";
  return null;
}
