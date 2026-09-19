import { endCard } from "../lib/cards.mjs";

export default {
  overlay: () => ({ bar: false }),
  async run(s) {
    await s.setContent(endCard(s.cfg));
    await s.start();
  },
};
