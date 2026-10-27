// pi 0.79.0: ProjectTrustStore, but no getDefaultProjectTrust and no hasTrustRequiringProjectResources
import { SettingsManager as Real } from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
export { getAgentDir, ProjectTrustStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
export const SettingsManager = { create: (...args) => { const s = Real.create(...args); return { ...s, getDefaultProjectTrust: undefined }; } };
