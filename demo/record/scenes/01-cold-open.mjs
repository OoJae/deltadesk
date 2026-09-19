import { quoteCard } from "../lib/cards.mjs";

export default {
  overlay: () => ({ bar: false }),
  async run(s) {
    await s.setContent(quoteCard(s.duration));
    await s.start();
  },
};
