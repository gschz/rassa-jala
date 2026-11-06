import { createPrismaClient } from "@rassa-jala/db";

import { ENV } from "./env.server";

export const db = createPrismaClient(ENV);
