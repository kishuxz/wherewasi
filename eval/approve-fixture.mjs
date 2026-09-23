// Evaluation fixtures are synthetic and live under an isolated home. Running
// eval/run.sh is the explicit choice to send them to the configured endpoint.
// Seed only that fixture's repository and endpoint; production CLI behavior
// still requires the interactive preview before a first hosted request.
import path from "node:path";
import { findRepoId } from "../dist/capture.js";
import { hostedDestination, recordHostedConsent } from "../dist/privacy.js";
import { selectProvider } from "../dist/providers/index.js";

const [repoPath, fixtureHome] = process.argv.slice(2);
if (!repoPath || !fixtureHome) throw new Error("usage: approve-fixture <repo> <isolated-home>");
const { provider, reason } = selectProvider({ ...process.env, WHEREWASI_API_KEY: "fixture-key" });
if (!provider) throw new Error(reason ?? "no evaluation provider");
const destination = hostedDestination(provider);
if (destination) {
  const scope = (await findRepoId(repoPath)) ?? path.resolve(repoPath);
  await recordHostedConsent(destination, scope, fixtureHome);
}
