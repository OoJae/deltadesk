import { economicsCard } from "../lib/cards.mjs";

export default {
  overlay: () => ({ bar: false }),
  async run(s) {
    await s.setContent(economicsCard());
    await s.start();
  },
};
