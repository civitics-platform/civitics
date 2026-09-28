// FIX-460: the presets lint themselves with the base preset. Two .js config
// files and one tailwind .ts — zero findings at landing (cc-168 read 2).
module.exports = {
  root: true,
  extends: ["./eslint/base.js"],
};
