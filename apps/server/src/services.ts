import { createPrismaClient } from "@rassa-jala/db";

import { ENV } from "./env.server";
import { createStorageDriver } from "./services/storage";

export const db = createPrismaClient(ENV);
export const storage = createStorageDriver();
