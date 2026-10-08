export type Destination = { organizationId: string; fileId?: string; userId: string };
export type ImportJob = {
  state: "selecting" | "importing" | "done" | "error";
  userId: string;
  tabId: number;
  destination?: Destination;
  url?: string;
  error?: string;
  warnings?: { message: string }[];
};
export type Reply<T> = { data: T } | { error: string };
