import { parseFrontmatter as piParseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createDeclarativeParser } from "@ghost/runtime/declarative-types";
export const { parseFrontmatter, buildRuleFromMarkdown } = createDeclarativeParser(piParseFrontmatter);
