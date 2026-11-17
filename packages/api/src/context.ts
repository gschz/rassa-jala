import type { Database } from "@rassa-jala/db";

export const ROLE = {
  ADMIN: "admin",
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

export type ContextUser = {
  id: string;
  role: Role;
};

export type Context = {
  db: Database;
  user: ContextUser;
};
