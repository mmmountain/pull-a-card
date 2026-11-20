// Two apps from one codebase:
//   Prompter      (main branch)  your everyday app            com.scott.pullacard      updates channel "production"
//   Prompter Dev  (dev branch)   new work, installed beside it com.scott.pullacard.dev  updates channel "dev"
// CI sets APP_VARIANT=dev when it builds or updates from the dev branch.
module.exports = ({ config }) => {
  if (process.env.APP_VARIANT !== "dev") return config;
  return {
    ...config,
    name: "Prompter Dev",
    android: { ...config.android, package: config.android.package + ".dev" },
    updates: { ...config.updates, requestHeaders: { "expo-channel-name": "dev" } },
  };
};
