// "What's new" dialog: the best recent features, newest first. Keep it short (the full list is CHANGELOG.md, linked
// at the bottom of the dialog). No version numbers here: the commit hook assigns them at commit time.
export const HIGHLIGHTS = [
  {
    title: 'The light’s own effects',
    text: 'All 20 built-in effects (Lightning, Cop Car, Paparazzi, Fireworks, Strobe…) are now the main Effects tiles. They run on the light itself, so they’re smooth and keep going if Bluetooth drops.',
    where: 'Show tab → Effects. Keys Q–Y start the first six.',
  },
  {
    title: 'Brightness controls a running effect',
    text: 'With a built-in effect running, the Brightness slider and ↑/↓ set the effect’s brightness; the effect keeps running.',
    where: 'Show tab → Brightness.',
  },
  {
    title: 'A different effect on every light',
    text: 'Each light can run its own effect at the same time, and the board shows whichever light you select.',
    where: 'Pick a light at the top (or press Tab), then an effect.',
  },
  {
    title: 'Build your own effects',
    text: 'Chain colors with hold and fade times, pick colors with a color picker, randomize level, hold and fade, and go as fast as 0.06 s per step.',
    where: 'Effects tab → + New effect.',
  },
  {
    title: 'Pre-show check',
    text: 'One button confirms every light is connected and answering, and dims each one briefly so you can see which is which.',
    where: 'Check, top right.',
  },
  {
    title: 'A link you can trust',
    text: 'Lost commands are resent, a silent light shows “no reply” within seconds and reconnects by itself, and it comes back the way it was.',
    where: 'Automatic.',
  },
  {
    title: 'Gels',
    text: 'Approximate gel colors (CTO/CTB, ambers, pinks, blues…) that change the color and keep the brightness.',
    where: 'Show tab → Gel menu.',
  },
  {
    title: 'More lights, faster',
    text: 'Add lights from the Show tab, double-click a light to rename it, Tab between lights, and black out one light at a time.',
    where: '+ next to the light chips; buttons under Blackout.',
  },
];
