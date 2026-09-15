import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const target = new URL("../.env.local", import.meta.url);
if (existsSync(target)) {
  console.log(
    ".env.local already exists. Existing configuration was preserved.",
  );
} else {
  const template = readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  const content = template
    .replace(
      /^AUTH_SECRET=$/m,
      `AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    )
    .replace(
      /^AGENT_SERVICE_TOKEN=$/m,
      `AGENT_SERVICE_TOKEN=${randomBytes(32).toString("hex")}`,
    );
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  console.log(
    "Created .env.local with private local secrets and local vector storage. Add your OpenAI key there. Set VECTOR_BACKEND=pinecone and its credentials to use Pinecone. Existing server/.env OpenAI and SerpAPI keys can be reused.",
  );
}
