import { Account, Client, Realtime, TablesDB } from "appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;

export const appwriteReady = Boolean(endpoint && projectId);
export const client = new Client();

if (endpoint) client.setEndpoint(endpoint);
if (projectId) client.setProject(projectId);

export const account = new Account(client);
export const tablesDB = new TablesDB(client);
export const realtime = new Realtime(client);

export const databaseId = process.env.NEXT_PUBLIC_APPWRITE_DATABASE_ID ?? "";
export const boardsCollectionId =
  process.env.NEXT_PUBLIC_APPWRITE_BOARDS_COLLECTION_ID ??
  process.env.NEXT_PUBLIC_APPWRITE_ROOMS_TABLE_ID ??
  "";
export const pixelsCollectionId = process.env.NEXT_PUBLIC_APPWRITE_PIXELS_COLLECTION_ID ?? "";
export const databaseReady = Boolean(appwriteReady && databaseId && boardsCollectionId && pixelsCollectionId);
