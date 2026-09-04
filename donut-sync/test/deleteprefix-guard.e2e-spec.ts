import { ForbiddenException } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import type { UserContext } from "../src/auth/user-context.interface.js";
import type {
  DeletePrefixRequestDto,
  DeletePrefixResponseDto,
} from "../src/sync/dto/sync.dto.js";
import { SyncService } from "../src/sync/sync.service.js";
import { configureTestEnv } from "./test-env.js";

// Mirrors the constant in sync.service.ts; reproduced here so the spec is
// self-contained and doesn't depend on a private export.
const MANIFEST_KEY = ".donut-sync-manifest";

interface ListPage {
  Contents: Array<{ Key: string; Size?: number }>;
  nextToken?: string;
}

interface RecordedSend {
  commandName: string;
  input: unknown;
}

function objectsFromDeleteInput(input: unknown): { Key: string }[] {
  if (typeof input !== "object" || input === null) return [];
  return (
    (input as { Delete?: { Objects?: { Key: string }[] } }).Delete?.Objects ??
    []
  );
}

function listPrefixFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as { Prefix?: string }).Prefix;
}

function putKeyFromInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as { Key?: string }).Key;
}

/**
 * Regression guard for the cloud/team bulk-delete escape hatch: an empty
 * (or slash-only) unscoped `prefix` scopes to the whole shared team namespace,
 * so a single `POST /v1/objects/delete-prefix` could wipe every member's data
 * and all reconciliation tombstones. The fix rejects it up front.
 *
 * These specs drive the real `SyncService` with a stubbed S3 client so they
 * need no live MinIO (the guard fires before any S3 call, and the success-path
 * assertions only inspect the recorded commands, never a real bucket).
 */
describe("SyncService deletePrefix whole-scope guard (e2e)", () => {
  let service: SyncService;
  let sent: RecordedSend[];
  let listPages: ListPage[];
  let listCalls: number;

  const teamCtx: UserContext = {
    mode: "cloud",
    prefix: "users/owner/",
    profileLimit: 0,
    sub: "malicious-member",
  };

  const ownerCtx: UserContext = {
    mode: "cloud",
    prefix: "users/owner/",
    profileLimit: 0,
    sub: "owner",
  };

  const selfHostedCtx: UserContext = {
    mode: "self-hosted",
    prefix: "",
    profileLimit: 0,
  };

  const deleteObjectsBatches = (): Array<{ Key: string }[]> =>
    sent
      .filter((s) => s.commandName === "DeleteObjectsCommand")
      .map((s) => objectsFromDeleteInput(s.input));

  const listPrefixes = (): (string | undefined)[] =>
    sent
      .filter((s) => s.commandName === "ListObjectsV2Command")
      .map((s) => listPrefixFromInput(s.input));

  beforeAll(async () => {
    configureTestEnv();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      providers: [SyncService],
    }).compile();
    // Use `.get()` (not `.init()`) deliberately: onModuleInit runs
    // ensureBucketExists against a real S3, which we neither want nor need
    // once the s3Client is stubbed below.
    service = moduleRef.get(SyncService);
    sent = [];
    listPages = [];
    listCalls = 0;

    const stub = {
      send: jest.fn(async (command: { constructor: { name: string } }) => {
        const input = (command as unknown as { input?: unknown }).input;
        sent.push({ commandName: command.constructor.name, input });
        switch (command.constructor.name) {
          case "ListObjectsV2Command": {
            const page = listPages[listCalls] ?? { Contents: [] };
            listCalls += 1;
            return {
              Contents: page.Contents,
              IsTruncated: Boolean(page.nextToken),
              NextContinuationToken: page.nextToken,
            };
          }
          case "DeleteObjectsCommand":
            return {};
          case "PutObjectCommand":
            return {};
          default:
            return {};
        }
      }),
    };
    (service as unknown as { s3Client: typeof stub }).s3Client = stub;
    (service as unknown as { presignClient: typeof stub }).presignClient = stub;
  });

  beforeEach(() => {
    sent.length = 0;
    listPages = [];
    listCalls = 0;
  });

  // Flush any fire-and-forget bumpManifest so its PutObject can't pollute a
  // later test's `sent` snapshot.
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  describe("whole-scope bulk delete must be refused (cloud/team mode)", () => {
    it("rejects an empty unscoped prefix with ForbiddenException", async () => {
      const promise = service.deletePrefix({ prefix: "" }, teamCtx);
      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      await expect(promise).rejects.toThrow(
        "Refusing to delete an empty prefix",
      );
    });

    it("issues no S3 List/Delete before refusing", async () => {
      await expect(
        service.deletePrefix({ prefix: "" }, teamCtx),
      ).rejects.toThrow();
      expect(sent).toHaveLength(0);
      expect(listPrefixes()).toHaveLength(0);
      expect(deleteObjectsBatches()).toHaveLength(0);
    });

    it("rejects a missing (undefined) prefix instead of throwing a TypeError", async () => {
      const dto = { prefix: undefined } as unknown as DeletePrefixRequestDto;
      await expect(service.deletePrefix(dto, teamCtx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(sent).toHaveLength(0);
    });

    it("rejects a null prefix", async () => {
      const dto = { prefix: null } as unknown as DeletePrefixRequestDto;
      await expect(service.deletePrefix(dto, teamCtx)).rejects.toThrow(
        "Refusing to delete an empty prefix",
      );
      expect(sent).toHaveLength(0);
    });

    it.each([
      "/",
      "//",
      "///",
    ])("rejects a slash-only prefix %p (scopes to the whole namespace)", async (slash) => {
      await expect(
        service.deletePrefix({ prefix: slash }, teamCtx),
      ).rejects.toThrow("Refusing to delete an empty prefix");
      expect(listPrefixes()).toHaveLength(0);
      expect(deleteObjectsBatches()).toHaveLength(0);
    });

    it("rejects for the team owner too (owner and members share the namespace)", async () => {
      await expect(
        service.deletePrefix({ prefix: "" }, ownerCtx),
      ).rejects.toThrow("Refusing to delete an empty prefix");
      expect(sent).toHaveLength(0);
    });
  });

  describe("legitimate narrow prefixes still work", () => {
    it("lists under the scoped prefix, deletes matching objects, and writes the tombstone", async () => {
      listPages = [
        {
          Contents: [
            { Key: "users/owner/profiles/p1/a.json", Size: 1 },
            { Key: "users/owner/profiles/p1/b.json", Size: 4 },
          ],
          nextToken: undefined,
        },
      ];

      const res: DeletePrefixResponseDto = await service.deletePrefix(
        {
          prefix: "profiles/p1/",
          tombstoneKey: "tombstones/profiles/p1.json",
          deletedAt: "2026-01-01T00:00:00.000Z",
        },
        teamCtx,
      );

      expect(res.deletedCount).toBe(2);
      expect(res.tombstoneCreated).toBe(true);

      // The list and the delete were scoped under the caller's shared namespace.
      expect(listPrefixes()).toEqual(["users/owner/profiles/p1/"]);

      const batches = deleteObjectsBatches();
      expect(batches).toHaveLength(1);
      expect(batches[0].map((o) => o.Key).sort()).toEqual([
        "users/owner/profiles/p1/a.json",
        "users/owner/profiles/p1/b.json",
      ]);

      // A tombstone PUT was issued at the scoped tombstone key.
      const tombstonePut = sent.find(
        (s) =>
          s.commandName === "PutObjectCommand" &&
          putKeyFromInput(s.input) ===
            "users/owner/tombstones/profiles/p1.json",
      );
      expect(tombstonePut).toBeDefined();
    });

    it("allows a non-empty prefix with a trailing slash (only empty/slash-only are refused)", async () => {
      listPages = [
        { Contents: [{ Key: "users/owner/profiles/x.json", Size: 1 }] },
      ];
      const res = await service.deletePrefix({ prefix: "profiles/" }, teamCtx);
      expect(res.deletedCount).toBe(1);
      expect(listPrefixes()).toEqual(["users/owner/profiles/"]);
    });
  });

  describe("defense-in-depth: the scope manifest is never bulk-deleted", () => {
    it("excludes the manifest from a delete batch that happens to list it", async () => {
      listPages = [
        {
          Contents: [
            { Key: "users/owner/profiles/p1/a.json", Size: 1 },
            { Key: `users/owner/${MANIFEST_KEY}`, Size: 2 },
            { Key: "users/owner/tombstones/old.json", Size: 3 },
          ],
          nextToken: undefined,
        },
      ];

      const res = await service.deletePrefix({ prefix: "profiles/" }, teamCtx);

      // The listed manifest counts toward neither the batch nor deletedCount.
      expect(res.deletedCount).toBe(2);
      const batches = deleteObjectsBatches();
      expect(batches).toHaveLength(1);
      const keys = batches[0].map((o) => o.Key);
      expect(keys).not.toContain(`users/owner/${MANIFEST_KEY}`);
      expect(keys).toContain("users/owner/profiles/p1/a.json");
      expect(keys).toContain("users/owner/tombstones/old.json");
    });

    it("keeps the manifest out of delete batches across paginated listings", async () => {
      listPages = [
        {
          Contents: [
            { Key: "users/owner/profiles/p1/a.json", Size: 1 },
            { Key: `users/owner/${MANIFEST_KEY}`, Size: 2 },
          ],
          nextToken: "tok1",
        },
        {
          Contents: [
            { Key: "users/owner/profiles/p1/b.json", Size: 4 },
            { Key: "users/owner/tombstones/old.json", Size: 8 },
          ],
          nextToken: undefined,
        },
      ];

      const res = await service.deletePrefix({ prefix: "profiles/" }, teamCtx);
      expect(res.deletedCount).toBe(3); // 1 + 2; the manifest is never counted

      // Two list calls (paginated), one delete per page; manifest is excluded.
      expect(listPrefixes()).toHaveLength(2);
      expect(deleteObjectsBatches()).toHaveLength(2);
      const allKeys = deleteObjectsBatches()
        .flat()
        .map((o) => o.Key);
      expect(allKeys).not.toContain(`users/owner/${MANIFEST_KEY}`);
      expect(allKeys.sort()).toEqual(
        [
          "users/owner/profiles/p1/a.json",
          "users/owner/profiles/p1/b.json",
          "users/owner/tombstones/old.json",
        ].sort(),
      );
    });
  });

  describe("self-hosted mode is unaffected (no cross-tenant blast radius)", () => {
    it("does not reject an empty prefix in self-hosted mode", async () => {
      listPages = [{ Contents: [{ Key: "anything/data.json", Size: 1 }] }];
      const res = await service.deletePrefix({ prefix: "" }, selfHostedCtx);
      // Reaching here means no ForbiddenException was thrown; the verbatim
      // (unscoped) empty prefix is used for the LIST, matching prior behaviour.
      expect(res.deletedCount).toBe(1);
      expect(listPrefixes()).toEqual([""]);
      expect(
        deleteObjectsBatches()
          .flat()
          .map((o) => o.Key),
      ).toEqual(["anything/data.json"]);
    });
  });
});
