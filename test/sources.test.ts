import { describe, expect, it } from "vitest";
import { redactLocation, resolveMetadataSource } from "../src/metadata/sources.js";

describe("metadata sources", () => {
  it("strips credentials from clone URLs", () => {
    expect(redactLocation("https://PAT123@dev.azure.com/acme/core/_git/salesforce")).toBe("https://dev.azure.com/acme/core/_git/salesforce");
    expect(redactLocation("https://user:secret@gitlab.com/acme/core.git")).toBe("https://gitlab.com/acme/core.git");
    expect(redactLocation("acme/core")).toBe("acme/core");
  });

  it("refuses option-like locations before running any CLI", async () => {
    await expect(resolveMetadataSource({ provider: "git", location: "--upload-pack=x" }, "/tmp/unused")).rejects.toThrow(/must not start with "-"/);
    await expect(resolveMetadataSource({ provider: "gitlab", location: "acme/core", ref: "-x" }, "/tmp/unused")).rejects.toThrow(/must not start with "-"/);
  });
});
