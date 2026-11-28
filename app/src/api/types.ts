import type {
  AddBrollRequest,
  AddBrollResponse,
  BatchDetail,
  CompleteUploadsRequest,
  CompleteUploadsResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateRenderRequest,
  CreateRenderResponse,
  EdlVersionResponse,
  GoalView,
  HomeResponse,
  ListEdlVersionsResponse,
  ListStylesResponse,
  ListVideosResponse,
  MarkPostedRequest,
  RegisterDeviceRequest,
  ReissueUploadsRequest,
  ReissueUploadsResponse,
  RenderView,
  ReplanRequest,
  RestoreEdlRequest,
  SaveEdlRequest,
  SaveEdlResponse,
  SaveStyleRequest,
  Style,
  UpdateGoalRequest,
  VideoDetail,
  VideoStatus,
  VideoSummary,
} from '@kilo/edl';

/**
 * Every route in docs/CONTRACTS.md section 5, one method each. Implemented by the
 * HTTP client (src/api/http.ts) and the in-memory mock (src/api/mock/). Every
 * method rejects with a KiloApiError.
 *
 * Request bodies use zod *input* types where the schema has defaults, so callers
 * may omit defaulted fields.
 */
export interface KiloApi {
  health(): Promise<{ ok: true }>;
  home(): Promise<HomeResponse>;

  createBatch(body: CreateBatchRequestInput): Promise<CreateBatchResponse>;
  getBatch(batchId: string): Promise<BatchDetail>;
  completeUploads(body: Partial<CompleteUploadsRequest>): Promise<CompleteUploadsResponse>;
  /** Fresh upload targets for files not in yet (an expired target, or a file the server refused). */
  reissueUploads(body: Partial<ReissueUploadsRequest>): Promise<ReissueUploadsResponse>;

  listVideos(query?: ListVideosQuery): Promise<ListVideosResponse>;
  getVideo(videoId: string): Promise<VideoDetail>;
  deleteVideo(videoId: string): Promise<void>;
  retryVideo(videoId: string): Promise<VideoSummary>;
  saveEdl(videoId: string, body: SaveEdlRequest): Promise<SaveEdlResponse>;
  /** Every saved revision of the video's edit, newest first. */
  listEdlVersions(videoId: string): Promise<ListEdlVersionsResponse>;
  /** One revision's EDL exactly as saved. */
  getEdlVersion(videoId: string, revision: number): Promise<EdlVersionResponse>;
  /** Stores an earlier revision's edit as a new revision (current + 1). */
  restoreEdl(videoId: string, body: RestoreEdlRequest): Promise<SaveEdlResponse>;
  addBroll(videoId: string, body: AddBrollRequest): Promise<AddBrollResponse>;
  deleteBroll(videoId: string, assetId: string): Promise<void>;
  replan(videoId: string, body: ReplanRequest): Promise<VideoSummary>;
  createRenders(videoId: string, body: CreateRenderRequest): Promise<CreateRenderResponse>;
  getRender(renderId: string): Promise<RenderView>;
  markPosted(videoId: string, body: MarkPostedRequest): Promise<VideoSummary>;

  getGoal(): Promise<GoalView>;
  updateGoal(body: UpdateGoalRequest): Promise<GoalView>;

  listStyles(): Promise<ListStylesResponse>;
  createStyle(body: SaveStyleRequest): Promise<Style>;
  updateStyle(styleId: string, body: SaveStyleRequest): Promise<Style>;
  deleteStyle(styleId: string): Promise<void>;

  registerDevice(body: RegisterDeviceRequest): Promise<void>;
  /** On sign-out, before the session is cleared: this device stops getting this account's notifications. */
  unregisterDevice(body: { expoPushToken: string }): Promise<void>;
}

/**
 * GET /videos query. `limit` and `after` page through the list: `after` is the id of the
 * last video of the previous page (ListVideosResponse carries no cursor), and a page
 * shorter than `limit` is the last one.
 */
export interface ListVideosQuery {
  status?: VideoStatus | VideoStatus[];
  batchId?: string;
  /** Words in the title. */
  q?: string;
  /** `created`: newest first (default). `batch`: newest batch first, each batch in its own order. */
  order?: 'created' | 'batch';
  limit?: number;
  after?: string;
}

/** CreateBatchRequest where each video's `broll` may be omitted (it defaults to []). */
export type CreateBatchRequestInput = Omit<CreateBatchRequest, 'videos'> & {
  videos: Array<Omit<CreateBatchRequest['videos'][number], 'broll'> & { broll?: CreateBatchRequest['videos'][number]['broll'] }>;
};

/** Statuses in which a video is still moving on its own and worth polling. */
export const BUSY_STATUSES: readonly VideoStatus[] = ['uploading', 'queued', 'analyzing', 'rendering'];

export function isBusy(status: VideoStatus): boolean {
  return BUSY_STATUSES.includes(status);
}
