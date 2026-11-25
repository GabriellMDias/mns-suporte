import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const composeFile = join(root, "infra", "compose.yaml");
const systemTemp = resolve(tmpdir());
const scratch = mkdtempSync(join(systemTemp, "mns-rehearsal-"));
const prefix = "mns-check-" + randomBytes(5).toString("hex");
const emptyEnv = join(scratch, "compose.env");
const storage = join(scratch, "backups");
const keyPath = join(scratch, "backup.key");
const images = {
  api: prefix + ":current",
  previous: prefix + ":previous",
  migration: prefix + ":migration",
  backup: prefix + ":backup",
};
const createdProjects = [];

function run(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function project(name) {
  const projectName = prefix + "-" + name;
  const secrets = join(scratch, "secrets-" + name);
  mkdirSync(secrets, { mode: 0o700 });
  for (const role of ["admin", "migration", "runtime", "maintenance"])
    writeFileSync(
      join(secrets, role + ".password"),
      randomBytes(32).toString("base64url"),
      { mode: 0o444, flag: "wx" },
    );
  writeFileSync(join(secrets, "api.env"), "", { mode: 0o444, flag: "wx" });
  const env = {
    ...process.env,
    COMPOSE_ANSI: "never",
    MNS_API_IMAGE: images.api,
    MNS_MIGRATION_IMAGE: images.migration,
    MNS_BACKUP_IMAGE: images.backup,
    MNS_SECRETS_DIR: secrets,
    MNS_BACKUP_DIR: storage,
    MNS_BACKUP_KEY_FILE: keyPath,
    MNS_BACKUP_UID: String(process.getuid?.() ?? 0),
    MNS_BACKUP_GID: String(process.getgid?.() ?? 0),
    MNS_API_PORT: "0",
    MNS_ENVIRONMENT: "test",
    MNS_RELEASE_ID: prefix,
  };
  const args = [
    "compose",
    "--env-file",
    emptyEnv,
    "--project-name",
    projectName,
    "--file",
    composeFile,
  ];
  function command(parts, override = {}) {
    return run("docker", [...args, ...parts], {
      env: { ...env, ...override },
    }).trim();
  }
  createdProjects.push({ projectName, command });
  return command;
}

function query(stack, statement) {
  return stack([
    "exec",
    "-T",
    "db",
    "psql",
    "-X",
    "--set=ON_ERROR_STOP=1",
    "-U",
    "mns_admin",
    "-d",
    "mns_suporte",
    "-Atc",
    statement,
  ]);
}

function exerciseRoles(stack) {
  const result = query(
    stack,
    `
    SELECT
      has_table_privilege('orion_runtime', 'public.whatsapp_inbound_messages', 'SELECT')
      AND has_table_privilege('orion_runtime', 'public.whatsapp_inbound_messages', 'INSERT')
      AND NOT has_table_privilege('orion_runtime', 'public.whatsapp_inbound_messages', 'DELETE')
      AND NOT has_column_privilege('orion_runtime', 'public.whatsapp_inbound_messages', 'content', 'UPDATE')
      AND NOT has_table_privilege('orion_runtime', 'public._prisma_migrations', 'SELECT')
      AND NOT has_schema_privilege('orion_runtime', 'public', 'CREATE')
      AND NOT has_function_privilege('orion_runtime', 'mns_ops.prune()', 'EXECUTE')
      AND has_function_privilege('mns_maintenance', 'mns_ops.prune()', 'EXECUTE')
      AND NOT has_table_privilege('mns_maintenance', 'public.whatsapp_inbound_messages', 'SELECT');
  `,
  );
  assert.equal(result, "t");
}

async function verifyApi(stack, expectedTag, override = {}) {
  const container = stack(["ps", "-q", "api"], override);
  const actual = run("docker", [
    "inspect",
    "--format",
    "{{.Image}}",
    container,
  ]).trim();
  const expected = run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    expectedTag,
  ]).trim();
  assert.equal(
    actual,
    expected,
    "The running image must match the selected artifact",
  );
  const address = stack(["port", "api", "3000"], override);
  assert.match(address, /^127\.0\.0\.1:[1-9]\d{0,4}$/u);
  const response = await fetch("http://" + address + "/health/ready", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const database = stack(["ps", "-q", "db"], override);
  const bindings = run("docker", [
    "inspect",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    database,
  ]).trim();
  assert.deepEqual(JSON.parse(bindings) ?? {}, {});
}

function previousSource() {
  const configured =
    process.env.MNS_REHEARSAL_PREVIOUS ?? process.env.ORION_RELEASE_BASE_REF;
  const candidate =
    configured && !/^0+$/u.test(configured) ? configured : "HEAD^";
  const revision = run("git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    candidate + "^{commit}",
  ]).trim();
  const old = join(scratch, "previous");
  const archive = join(scratch, "previous.tar");
  mkdirSync(old);
  run("git", ["archive", "--format=tar", "--output=" + archive, revision]);
  run("tar", ["-xf", archive, "-C", old]);
  mkdirSync(join(old, "infra"), { recursive: true });
  cpSync(join(root, "infra", "Dockerfile"), join(old, "infra", "Dockerfile"));
  cpSync(join(root, "infra", "container"), join(old, "infra", "container"), {
    recursive: true,
  });
  cpSync(join(root, ".dockerignore"), join(old, ".dockerignore"));
  run(
    "docker",
    [
      "build",
      "--target",
      "api",
      "--build-arg",
      "MNS_IMAGE_RELEASE=" + revision,
      "--file",
      join(old, "infra", "Dockerfile"),
      "--tag",
      images.previous,
      old,
    ],
    { stdio: "inherit" },
  );
  return revision;
}

function seed(stack) {
  query(
    stack,
    `
    INSERT INTO whatsapp_inbound_messages
        (message_id, business_phone_id, sender_phone, occurred_at, received_at, conversation_processed_at, content)
    VALUES
        ('rehearsal-current', '10101', '15550001001', now(), now(), now(), '{"type":"text","body":"preserved marker"}'),
        ('rehearsal-scrub', '10101', '15550001001', now()-interval '3 days', now()-interval '3 days', now()-interval '3 days', '{"type":"text","body":"discarded marker"}'),
        ('rehearsal-delete', '10101', '15550001001', now()-interval '31 days', now()-interval '31 days', now()-interval '31 days', '{"type":"text","body":"expired marker"}');
    INSERT INTO whatsapp_ticket_submissions
        (draft_id, business_phone_id, scope_key, requester_id, reply_expires_at, media_ids,
         attachment_count, state, available_at, updated_at, ticket_id, closure_consent_id, closure_check_at)
    VALUES
        ('ee1acc37-67dd-4365-8cb0-0708e2de1020', '10101', 'synthetic-operations-scope', 37, now(), '[]',
         0, 'UNCERTAIN', now(), now(), NULL, NULL, NULL),
        ('ee1acc37-67dd-4365-8cb0-0708e2de1021', '10101', 'synthetic-active-draft', 37, now(), '[]',
         0, 'PENDING', now()+interval '1 day', now()-interval '31 days', NULL, NULL, NULL),
        ('ee1acc37-67dd-4365-8cb0-0708e2de1022', '10101', 'synthetic-active-notice', 37, now(), '[]',
         0, 'COMPLETED', now(), now()-interval '200 days', 120, 'ee1acc37-67dd-4365-8cb0-0708e2de1023', now()+interval '1 day');
    INSERT INTO whatsapp_conversations (scope_key, state, updated_at) VALUES
        ('synthetic-active-draft', '{"phase":"menu","draft":{"id":"ee1acc37-67dd-4365-8cb0-0708e2de1021","ownerId":37,"step":"review","revision":1,"editing":false,"attachments":[]}}',
         now()-interval '31 days');
  `,
  );
}

function verifyData(stack) {
  assert.equal(
    query(
      stack,
      "SELECT content->>'body' FROM whatsapp_inbound_messages WHERE message_id='rehearsal-current'",
    ),
    "preserved marker",
  );
  assert.equal(
    query(
      stack,
      "SELECT content->>'type' FROM whatsapp_inbound_messages WHERE message_id='rehearsal-scrub'",
    ),
    "redacted",
  );
  assert.equal(
    query(
      stack,
      "SELECT count(*) FROM whatsapp_inbound_messages WHERE message_id='rehearsal-delete'",
    ),
    "0",
  );
  assert.equal(
    query(
      stack,
      "SELECT count(*) FROM whatsapp_ticket_submissions WHERE state='UNCERTAIN' AND scope_key='synthetic-operations-scope'",
    ),
    "1",
  );
  assert.equal(
    query(
      stack,
      "SELECT count(*) FROM whatsapp_conversations WHERE scope_key='synthetic-active-draft'",
    ),
    "1",
  );
  assert.equal(
    query(
      stack,
      "SELECT count(*) FROM whatsapp_ticket_submissions WHERE scope_key='synthetic-active-notice' AND closure_check_at IS NOT NULL",
    ),
    "1",
  );
}

let failed = false;
try {
  mkdirSync(storage, { mode: 0o700 });
  writeFileSync(emptyEnv, "");
  writeFileSync(keyPath, randomBytes(48).toString("base64url"), {
    mode: 0o444,
    flag: "wx",
  });
  const source = project("source");
  const restored = project("restored");
  source(["config", "--quiet"]);
  console.log("Building source and rollback images");
  source(["--profile", "tools", "build", "api", "migrate", "backup"]);
  const revision = previousSource();
  const builtImageIds = run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    images.api,
    images.previous,
  ])
    .trim()
    .split(/\r?\n/u);
  assert.equal(
    new Set(builtImageIds).size,
    2,
    "Rollback needs two distinct release artifacts",
  );
  source([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--no-build",
    "api",
  ]);
  await verifyApi(source, images.api);
  exerciseRoles(source);
  assert.throws(
    () =>
      source(["run", "--rm", "--no-deps", "-e", "ORION_ENV=production", "api"]),
    (error) =>
      /deployment_configuration_failed/u.test(
        String(error.stderr) + String(error.stdout),
      ),
  );
  console.log(
    "Deployment, restricted roles and fail-closed production startup verified",
  );

  seed(source);
  const monitor = source([
    "run",
    "--rm",
    "--no-deps",
    "maintenance",
    "node",
    "ops/maintenance.mjs",
    "--once",
  ]);
  const records = monitor
    .split("\n")
    .flatMap((line) => (line.startsWith("{") ? [JSON.parse(line)] : []));
  assert.deepEqual(
    records.find(({ event }) => event === "retention_completed")?.counts,
    {
      inbox: 1,
      outbox: 0,
      feedback: 0,
      scrubbed: 1,
      challenges: 0,
      identities: 0,
      preferences: 0,
      submissions: 0,
      conversations: 0,
    },
  );
  assert.ok(
    records.some(
      ({ event, condition, state }) =>
        event === "operational_alert" &&
        condition === "ticket_submission_uncertain" &&
        state === "firing",
    ),
  );
  assert.doesNotMatch(
    monitor,
    /synthetic-operations-scope|15550001001|discarded marker/u,
  );
  verifyData(source);
  console.log("Retention and sanitized alert verified");

  const backupName = "rehearsal.dump.gpg";
  assert.match(
    source(["run", "--rm", "--no-deps", "backup", "create", backupName]),
    /backup_created/u,
  );
  const encrypted = readFileSync(join(storage, backupName));
  assert.doesNotMatch(encrypted.toString("utf8"), /PGDMP|preserved marker/u);
  assert.throws(
    () => source(["run", "--rm", "--no-deps", "backup", "create", backupName]),
    (error) =>
      /backup_operation_failed stage=publish/u.test(String(error.stderr)),
  );
  assert.equal(encrypted.equals(readFileSync(join(storage, backupName))), true);
  restored([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "60",
    "--no-build",
    "db",
  ]);
  const corruptedName = "corrupted.dump.gpg";
  writeFileSync(
    join(storage, corruptedName),
    encrypted.subarray(0, encrypted.length - 3),
  );
  assert.throws(
    () =>
      restored([
        "run",
        "--rm",
        "--no-deps",
        "backup",
        "restore",
        corruptedName,
      ]),
    (error) =>
      /backup_operation_failed stage=decrypt/u.test(String(error.stderr)),
  );
  assert.equal(
    query(
      restored,
      "SELECT to_regclass('public.whatsapp_inbound_messages') IS NULL",
    ),
    "t",
  );
  assert.match(
    restored(["run", "--rm", "--no-deps", "backup", "restore", backupName]),
    /backup_restored/u,
  );
  assert.throws(
    () =>
      restored(["run", "--rm", "--no-deps", "backup", "restore", backupName]),
    (error) => /restore_requires_empty_database/u.test(String(error.stderr)),
  );
  restored([
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
    "--no-build",
    "api",
  ]);
  await verifyApi(restored, images.api);
  exerciseRoles(restored);
  verifyData(restored);
  console.log("Authenticated backup and isolated restore verified");

  const rollback = { MNS_API_IMAGE: images.previous, MNS_RELEASE_ID: revision };
  source(
    [
      "up",
      "--detach",
      "--no-deps",
      "--force-recreate",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "60",
      "api",
    ],
    rollback,
  );
  await verifyApi(source, images.previous, rollback);
  verifyData(source);
  console.log(
    "Rollback verified with previous Git artifact and an intact database",
  );
} catch (error) {
  failed = true;
  console.error(error.message);
  for (const { command } of createdProjects) {
    try {
      console.error(
        command(["logs", "--no-color", "--tail", "25", "db", "migrate", "api"]),
      );
    } catch {
      /* A project can fail before creation. */
    }
  }
} finally {
  for (const { projectName, command } of createdProjects) {
    if (!/^mns-check-[a-f0-9]{10}-(?:source|restored)$/u.test(projectName)) {
      failed = true;
      console.error("Unexpected rehearsal project name");
      continue;
    }
    try {
      command(["--profile", "tools", "down", "--volumes", "--remove-orphans"]);
    } catch {
      failed = true;
      console.error("Could not remove rehearsal project " + projectName);
    }
  }
  for (const image of Object.values(images)) {
    try {
      run("docker", ["image", "rm", image], { stdio: "ignore" });
    } catch {
      /* An unsuccessful build may not create all images. */
    }
  }
  if (
    dirname(resolve(scratch)) !== systemTemp ||
    !/^mns-rehearsal-[A-Za-z0-9]+$/u.test(basename(scratch))
  ) {
    failed = true;
    console.error("Unexpected rehearsal workspace");
  } else {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      failed = true;
      console.error("Could not remove the rehearsal workspace");
    }
  }
  if (failed) process.exitCode = 1;
}
