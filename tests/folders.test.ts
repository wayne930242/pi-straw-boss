import assert from "node:assert/strict";
import { test } from "node:test";
import { child, leaf } from "../gui/folders.ts";

// The opening tile's folder words (gui/folders.ts): the base's default name is the picked folder's own, whichever separator the server uses.

test("a base is named after the picked folder by default, and home gives no name", () => {
	assert.equal(leaf("/home/me/sbd-playground/hello-test2", "/home/me"), "hello-test2");
	assert.equal(leaf("C:\\Users\\測試PM\\sbd-playground\\hello-test2", "C:\\Users\\測試PM"), "hello-test2", "a Windows path is cut at its backslash");
	assert.equal(leaf("C:\\Users\\測試PM\\中文專案", "C:\\Users\\測試PM"), "中文專案");
	assert.equal(leaf("/home/me", "/home/me"), "", "home is no name");
	assert.equal(leaf("C:\\Users\\測試PM", "C:\\Users\\測試PM"), "");
});

test("a child's path joins with the separator the server's paths use", () => {
	assert.equal(child("/home/me", "work", "/"), "/home/me/work");
	assert.equal(child("C:\\Users\\me", "work", "\\"), "C:\\Users\\me\\work");
	assert.equal(child("C:\\", "work", "\\"), "C:\\work", "a root already ends in its separator");
});
