import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic();
  const models = await client.models.list();
  for (const model of models.data) {
    console.log(model.id);
  }
}

main();
