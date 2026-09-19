import { titleCard } from "../lib/cards.mjs";

export default {
  overlay: () => ({ bar: false }),
  async run(s) {
    await s.setContent(titleCard());
    await s.start();
  },
};
