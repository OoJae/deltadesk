import { mondayCard } from "../lib/cards.mjs";

export default {
  overlay: () => ({ bar: false }),
  async run(s) {
    await s.setContent(mondayCard());
    await s.start();
  },
};
