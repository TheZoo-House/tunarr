import { MediaSourceDB } from '@/db/mediaSourceDB.js';
import { MediaSourceApiFactory } from '@/external/MediaSourceApiFactory.js';
import type {
  GetSubtitlesRequest,
  ScanContext,
} from '@/services/scanner/MediaSourceScanner.js';
import type { ProgramGrouping } from '@tunarr/types';
import { inject, injectable } from 'inversify';
import { GetProgramGroupingById } from '../../commands/GetProgramGroupingById.ts';
import { ProgramGroupingMinter } from '../../db/converters/ProgramGroupingMinter.ts';
import type { ProgramDaoMinter } from '../../db/converters/ProgramMinter.ts';
import { type IProgramDB } from '../../db/interfaces/IProgramDB.ts';
import type { MediaSourceWithRelations } from '../../db/schema/derivedTypes.js';
import type { QueryResult } from '../../external/BaseApiClient.ts';
import type { PlexApiClient } from '../../external/plex/PlexApiClient.ts';
import { ExternalSubtitleDownloader } from '../../stream/ExternalSubtitleDownloader.ts';
import type { WrappedError } from '../../types/errors.ts';
import { KEYS } from '../../types/inject.ts';
import type {
  PlexEpisode,
  PlexSeason,
  PlexShow,
  SeasonWithShow,
} from '../../types/Media.ts';
import type { Result } from '../../types/result.ts';
import { InjectLogger } from '../../util/inject.ts';
import type { Logger } from '../../util/logging/LoggerFactory.ts';
import { MeilisearchService } from '../MeilisearchService.ts';
import { MediaSourceProgressService } from './MediaSourceProgressService.ts';
import { MediaSourceTvShowLibraryScanner } from './MediaSourceTvShowLibraryScanner.ts';
import { PlexScanUtil } from './PlexScanUtil.ts';

@injectable()
export class PlexMediaSourceTvShowScanner extends MediaSourceTvShowLibraryScanner<
  'plex',
  PlexApiClient,
  PlexShow,
  PlexSeason,
  PlexEpisode
> {
  readonly mediaSourceType = 'plex';

  @InjectLogger() declare protected readonly logger: Logger;

  constructor(
    @inject(MediaSourceDB) mediaSourceDB: MediaSourceDB,
    @inject(KEYS.ProgramDB) programDB: IProgramDB,
    @inject(MediaSourceApiFactory)
    private mediaSourceApiFactory: MediaSourceApiFactory,
    @inject(KEYS.ProgramDaoMinterFactory)
    programMinterFactory: () => ProgramDaoMinter,
    @inject(ProgramGroupingMinter)
    programGroupingMinter: ProgramGroupingMinter,
    @inject(MeilisearchService) searchService: MeilisearchService,
    @inject(MediaSourceProgressService)
    mediaSourceProgressService: MediaSourceProgressService,
    @inject(GetProgramGroupingById)
    getProgramGroupingsById: GetProgramGroupingById,
    @inject(ExternalSubtitleDownloader)
    externalSubtitleDownloader: ExternalSubtitleDownloader,
  ) {
    super(
      mediaSourceDB,
      programDB,
      programGroupingMinter,
      programMinterFactory(),
      searchService,
      mediaSourceProgressService,
      getProgramGroupingsById,
      externalSubtitleDownloader,
    );
  }

  protected override readonly supportsQuickScan = true;

  // One lookup per quick scan, shared by the size and contents calls.
  #changedShows = new WeakMap<
    ScanContext<PlexApiClient>,
    Promise<Set<string>>
  >();

  private changedShows(libraryId: string, context: ScanContext<PlexApiClient>) {
    let changed = this.#changedShows.get(context);
    if (!changed && context.quickSince) {
      changed = context.apiClient
        .getChangedShowKeys(libraryId, context.quickSince)
        .then((result) => result.getOrThrow());
      this.#changedShows.set(context, changed);
    }
    return changed;
  }

  protected async *getTvShowLibraryContents(
    libraryId: string,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexShow> {
    const changed = await this.changedShows(libraryId, context);
    for await (const show of context.apiClient.getTvShowLibraryContents(
      libraryId,
    )) {
      if (!changed || changed.has(show.externalId)) {
        yield show;
      }
    }
  }

  protected getTvShowSeasons(
    show: PlexShow,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexSeason> {
    return context.apiClient.getShowSeasons(show.externalId);
  }

  protected getSeasonEpisodes(
    season: SeasonWithShow<PlexSeason, PlexShow>,
    context: ScanContext<PlexApiClient>,
  ): AsyncIterable<PlexEpisode> {
    return context.apiClient.getSeasonEpisodes(
      season.show.externalId,
      season.externalId,
    );
  }

  protected getFullEpisodeMetadata(
    episodeT: PlexEpisode,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexEpisode, WrappedError>> {
    return context.apiClient.getEpisode(episodeT.externalId);
  }

  protected getFullTvShowMetadata(
    externalId: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexShow, WrappedError>> {
    return context.apiClient.getShow(externalId);
  }

  protected getFullTvSeasonMetadata(
    externalId: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<Result<PlexSeason, WrappedError>> {
    return context.apiClient.getSeason(externalId);
  }

  protected getApiClient(
    mediaSource: MediaSourceWithRelations,
  ): Promise<PlexApiClient> {
    return this.mediaSourceApiFactory.getPlexApiClientForMediaSource(
      mediaSource,
    );
  }

  protected getEntityExternalKey(
    item: PlexShow | PlexSeason | PlexEpisode,
  ): string {
    return item.externalId;
  }

  protected async getLibrarySize(
    libraryKey: string,
    context: ScanContext<PlexApiClient>,
  ): Promise<number> {
    const changed = await this.changedShows(libraryKey, context);
    if (changed) {
      return changed.size;
    }
    return context.apiClient
      .getLibraryCount(libraryKey)
      .then((_) => _.getOrThrow());
  }

  protected isShowT(grouping: ProgramGrouping): grouping is PlexShow {
    return grouping.sourceType === 'plex' && grouping.type === 'show';
  }

  protected isSeasonT(grouping: ProgramGrouping): grouping is PlexSeason {
    return grouping.sourceType === 'plex' && grouping.type === 'season';
  }

  protected getSubtitles(
    context: ScanContext<PlexApiClient>,
    { key }: GetSubtitlesRequest,
  ): Promise<QueryResult<string>> {
    return PlexScanUtil.getSubtitles(context, key);
  }
}
