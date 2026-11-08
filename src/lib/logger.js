import chalk from "chalk";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = (msg) =>
  console.log(chalk.bold.hex("#9B8CFF")("[ ONYX ] » ") + msg);
export const cmd = (msg) =>
  console.log(chalk.bold.hex("#5A9786")("[ ONYX - CMD ] » ") + msg);
export const warn = (msg) =>
  console.warn(chalk.bold.hex("#F28C28")("[ ONYX - WARN ] » ") + msg);
export const error = (msg, err) => {
  console.error(
    chalk.bold.hex("#ED4245")(`[ ONYX - ERROR ] ${stamp()} » `) + msg,
  );
  if (err) console.error(err);
};
