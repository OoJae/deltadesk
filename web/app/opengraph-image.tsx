import { OG_ALT, OG_SIZE, renderShareCard } from "@/components/brand/og";

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return renderShareCard();
}
