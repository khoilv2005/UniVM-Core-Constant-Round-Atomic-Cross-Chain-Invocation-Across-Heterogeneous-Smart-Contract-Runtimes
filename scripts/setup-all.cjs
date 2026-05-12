const { execSync } = require("child_process");

const KNOWN_PROTOCOLS = ["atom", "gpact", "integratex"];

function parseArgs(argv) {
  const requestedProtocols = [];
  let deploy = true;
  let render = true;

  for (const arg of argv) {
    if (arg === "--deploy-only") {
      render = false;
      continue;
    }
    if (arg === "--render-only") {
      deploy = false;
      continue;
    }
    if (KNOWN_PROTOCOLS.includes(arg)) {
      requestedProtocols.push(arg);
      continue;
    }
    throw new Error(
      `Unknown argument: ${arg}\n` +
      `Usage: node scripts/setup-all.cjs [atom] [gpact] [integratex] [--deploy-only|--render-only]`
    );
  }

  return {
    protocols: requestedProtocols.length > 0 ? requestedProtocols : KNOWN_PROTOCOLS,
    deploy,
    render,
  };
}

function run(command) {
  console.log(`\n> ${command}`);
  execSync(command, { stdio: "inherit" });
}

function runProtocol(protocol, opts) {
  switch (protocol) {
    case "atom":
      if (opts.deploy) {
        run("npm run deploy:atom:bc1");
        run("npm run deploy:atom:bc2");
        run("npm run deploy:atom:bc3");
      }
      if (opts.render) {
        run("npm run render:atom");
      }
      return;

    case "gpact":
      if (opts.deploy) {
        run("npm run deploy:gpact:bc1");
        run("npm run deploy:gpact:bc2");
        run("npm run deploy:gpact:bc3");
      }
      if (opts.render) {
        run("npm run render:gpact:manifest");
        run("npm run render:gpact");
      }
      return;

    case "integratex":
      if (opts.deploy) {
        run("npm run deploy:integratex:bc1");
        run("npm run deploy:integratex:bc2");
        run("npm run deploy:integratex:bc3");
      }
      if (opts.render) {
        run("npm run render:integratex");
      }
      return;

    default:
      throw new Error(`Unsupported protocol: ${protocol}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Protocols: ${opts.protocols.join(", ")}`);
  console.log(`Deploy: ${opts.deploy ? "yes" : "no"}`);
  console.log(`Render: ${opts.render ? "yes" : "no"}`);

  for (const protocol of opts.protocols) {
    runProtocol(protocol, opts);
  }

  console.log("\nAll requested scripts completed.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
