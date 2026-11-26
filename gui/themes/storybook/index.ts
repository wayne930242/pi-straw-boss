import "./storybook.css";
import sprite from "./sprite.svg?raw";
import { mountAmbience } from "../../ambience.ts";
import { pageThemes } from "../manifest.ts";
import type { ThemeParts } from "../theme.ts";

export const theme: ThemeParts = {
	sprite,
	mount: ({ audio, phase }) => mountAmbience(audio, phase, pageThemes().storybook.ambience!),
};
