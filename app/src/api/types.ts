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
  GoalView,
  HomeResponse,
  ListStylesResponse,
  ListVideosResponse,
  MarkPostedRequest,
  RegisterDeviceRequest,
  RenderView,
  ReplanRequest,
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

  listVideos(query?: { status?: VideoStatus; batchId?: string }): Promise<ListVideosResponse>;
  getVideo(videoId: string): Promise<VideoDetail>;
  deleteVideo(videoId: string): Promise<void>;
  retryVideo(videoId: string): Promise<VideoSummary>;
  saveEdl(videoId: string, body: SaveEdlRequest): Promise<SaveEdlResponse>;
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
