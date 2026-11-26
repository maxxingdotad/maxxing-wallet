import { encode } from "uqr";

/** An address as a QR module matrix (no quiet zone; the card draws its own margin). Error correction M: still reads with a smudge. */
export const addressMatrix = (value: string) => encode(value, { ecc: "M", border: 0 });
