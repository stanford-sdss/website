/**
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Component for retrieving and transforming data into a form ready for drawing
 * and passing the data to a `Chart` component that draws the choropleth.
 */

import axios from "axios";
import _ from "lodash";
import React, { useContext, useEffect, useReducer, useState } from "react";

import { GeoJsonData, MapPoint } from "../../chart/types";
import { FacetSelectorFacetInfo } from "../../shared/facet_selector";
import {
  EntityObservation,
  EntityObservationList,
  EntitySeries,
  PointAllApiResponse,
  PointApiResponse,
  SeriesApiResponse,
  StatMetadata,
} from "../../shared/stat_types";
import { StatVarSummary } from "../../shared/types";
import { getCappedStatVarDate } from "../../shared/util";
import { stringifyFn } from "../../utils/axios";
import { ENCLOSED_PLACE_TYPE_NAMES } from "../../utils/place_utils";
import { BqModal } from "../shared/bq_modal";
import { setUpBqButton } from "../shared/bq_utils";
import { getMatchingObservation, getUnit } from "../shared_util";
import { getNonPcQuery, getPcQuery } from "./bq_query_utils";
import { Chart, MAP_TYPE } from "./chart";
import {
  ChartDataType,
  ChartStore,
  chartStoreReducer,
  emptyChartStore,
} from "./chart_store";
import {
  useComputeBreadcrumbValues,
  useComputeSampleDates,
} from "./compute_hooks";
import {
  Context,
  DisplayOptionsWrapper,
  IsLoadingWrapper,
  PlaceInfo,
  StatVar,
  StatVarWrapper,
} from "./context";
import { useFetchAllDates } from "./fetcher/all_dates";
import { useFetchBreadcrumbDenomStat } from "./fetcher/breadcrumb_denom_stat";
import { useFetchBreadcrumbStat } from "./fetcher/breadcrumb_stat";
import { useFetchEuropeanCountries } from "./fetcher/european_countries";
import { useFetchGeoJson } from "./fetcher/geojson";
import { useFetchGeoRaster } from "./fetcher/georaster";
import { useFetchMapPointCoordinate } from "./fetcher/map_point_coordinate";
import { useFetchMapPointStat } from "./fetcher/map_point_stat";
import { PlaceDetails } from "./place_details";
import {
  BEST_AVAILABLE_METAHASH,
  DataPointMetadata,
  getGeoJsonDataFeatures,
  getLegendBounds,
  getPlaceChartData,
  MANUAL_GEOJSON_DISTANCES,
} from "./util";

interface ChartRawData {
  enclosedPlaceStat: EntityObservation;
  allEnclosedPlaceStat: EntityObservationList;
  metadataMap: Record<string, StatMetadata>;
  population: EntitySeries;
  breadcrumbPlaceStat?: EntityObservation;
  dataDate: string;

  // Map of metahash to display domain for the map legend
  legendBounds: Record<string, [number, number, number]>;
}

interface ChartData {
  mapValues: { [dcid: string]: number };
  metadata: { [dcid: string]: DataPointMetadata };
  sources: Set<string>;
  dates: Set<string>;
  unit: string;
  mapPointValues: { [dcid: string]: number };
  mapPoints: Array<MapPoint>;
  rankingLink: string;

  // Array of ~10 dates for time slider
  sampleDates: Array<string>;

  // Current metahash
  metahash: string;
}

export function ChartLoader(): JSX.Element {
  const { placeInfo, statVar, isLoading, display } = useContext(Context);

  const [rawData, setRawData] = useState<ChartRawData | undefined>(undefined);
  const [chartData, setChartData] = useState<ChartData | undefined>(undefined);
  const [mapType, setMapType] = useState(MAP_TYPE.D3);

  // Map of metahash -> date -> ChartRawData
  const [sampleDatesChartData, setSampleDatesChartData] = useState<
    Record<string, Record<string, ChartRawData>>
  >({});
  const [onPlayCallback, setOnPlayCallback] = useState<() => void>();
  // TODO: UNCOMMENT TO RE-ENABLE BIGQUERY
  // const bqLink = useRef(setUpBqButton(getSqlQuery));

  // // TODO: add webdriver test for BigQuery button to ensure query works
  // useEffect(() => {
  //   bqLink.current.style.display = "inline-block";
  //   return () => {
  //     bqLink.current.style.display = "none";
  //   };
  // }, []);

  // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  const [chartStore, dispatch] = useReducer(chartStoreReducer, emptyChartStore);
  // -------------------------------------------------------------------------

  const europeanCountries = useFetchEuropeanCountries();
  useFetchGeoJson(dispatch);
  useFetchMapPointCoordinate(dispatch);
  useFetchMapPointStat(dispatch);
  useFetchBreadcrumbStat(dispatch);
  useFetchBreadcrumbDenomStat(chartStore, dispatch);
  useFetchMapPointStat(dispatch);
  useFetchGeoRaster(dispatch);
  useFetchAllDates(dispatch);

  const allSampleDates = useComputeSampleDates(chartStore);
  const breadcrumbValues = useComputeBreadcrumbValues(chartStore);

  // For IPCC grid data, geoJson features is calculated based on the grid
  // DCID.
  useEffect(() => {
    if (_.isEmpty(rawData) || _.isEmpty(chartStore.geoJson.data)) {
      return;
    }
    if (
      _.isEmpty(chartStore.geoJson.data.features) &&
      placeInfo.value.enclosedPlaceType in MANUAL_GEOJSON_DISTANCES
    ) {
      const geoJsonFeatures = getGeoJsonDataFeatures(
        Object.keys(rawData.enclosedPlaceStat),
        placeInfo.value.enclosedPlaceType
      );
      dispatch({
        type: ChartDataType.GEO_JSON,
        error: null,
        payload: {
          type: "FeatureCollection",
          properties: { current_geo: placeInfo.value.enclosingPlace.dcid },
          features: geoJsonFeatures,
        } as GeoJsonData,
      });
    }
  }, [chartStore.geoJson.data, placeInfo.value, rawData]);

  useEffect(() => {
    const placeSelected =
      !_.isEmpty(placeInfo.value.enclosingPlace.dcid) &&
      !_.isEmpty(placeInfo.value.enclosedPlaceType);
    if (
      placeSelected &&
      !_.isEmpty(statVar.value.dcid) &&
      !_.isNull(statVar.value.info)
    ) {
      fetchData(
        placeInfo.value,
        statVar.value,
        isLoading,
        setRawData,
        display.value.showTimeSlider,
        allSampleDates
      );
    } else {
      setRawData(undefined);
    }
  }, [
    placeInfo.value.enclosingPlace,
    placeInfo.value.enclosedPlaceType,
    statVar.value.dcid,
    statVar.value.info,
    statVar.value.denom,
    statVar.value.mapPointSv,
  ]);

  useEffect(() => {
    // Set map type to leaflet if georaster data is available before data needed
    // for d3 maps
    if (
      (_.isEmpty(rawData) || _.isEmpty(chartStore.geoJson.data)) &&
      !_.isEmpty(chartStore.geoRaster.data)
    ) {
      setMapType(MAP_TYPE.LEAFLET);
    }
  }, [rawData, chartStore.geoJson.data, chartStore.geoRaster.data]);

  useEffect(() => {
    if (_.isEmpty(rawData) || _.isEmpty(chartStore.geoJson.data)) {
      return;
    }
    const metahash = statVar.value.metahash || BEST_AVAILABLE_METAHASH;
    const dateRawData =
      statVar.value.date && sampleDatesChartData[metahash]
        ? sampleDatesChartData[metahash][statVar.value.date]
        : rawData;
    loadChartData(
      chartStore,
      dateRawData,
      placeInfo.value,
      allSampleDates,
      statVar.value,
      setChartData,
      display
    );
    // Should set legend bounds for per capita if there isn't a user specified
    // domain.
    if (
      statVar.value.perCapita &&
      statVar.value.denom &&
      _.isEmpty(display.value.domain)
    ) {
      setLegendBoundsPerCapita(rawData, statVar, display);
    }
  }, [
    rawData,
    chartStore.geoJson.data,
    chartStore.geoRaster.data,
    statVar.value.metahash,
    statVar.value.perCapita,
  ]);

  useEffect(() => {
    if (onPlayCallback) {
      onPlayCallback();
    }
  }, [sampleDatesChartData]);

  // TODO: once data fetches are separated out, render leaflet map without
  // waiting on chartData
  if (!rawData || !statVar.value.info || chartData === undefined) {
    return null;
  } else if (mapType === MAP_TYPE.D3 && _.isEmpty(chartStore.geoJson.data)) {
    <div className="p-5">
      {`Sorry, maps are not available for ${placeInfo.value.enclosedPlaceType} in ${placeInfo.value.selectedPlace.name}. Try picking another place or type of place.`}
    </div>;
  } else if (_.isEmpty(chartData) || _.isEmpty(chartData.mapValues)) {
    return (
      <div className="p-5">
        {`Sorry, the selected variable ${
          statVar.value.info.title || statVar.value.dcid
        } is not available for places in ${
          placeInfo.value.selectedPlace.name
        } of type ${
          ENCLOSED_PLACE_TYPE_NAMES[placeInfo.value.enclosedPlaceType] ||
          placeInfo.value.enclosedPlaceType
        }. Please try a different variable or different place options.`}
      </div>
    );
  }
  const facetInfo = getFacetInfo(
    statVar.value,
    rawData.allEnclosedPlaceStat,
    rawData.metadataMap
  );

  const onPlay = async (callback: () => void) => {
    setOnPlayCallback(() => callback);
    const metaHash = statVar.value.metahash || BEST_AVAILABLE_METAHASH;
    if (metaHash in sampleDatesChartData) {
      callback();
      return;
    }
    fetchData(
      placeInfo.value,
      statVar.value,
      isLoading,
      setRawData,
      display.value.showTimeSlider,
      allSampleDates,
      allSampleDates[metaHash],
      sampleDatesChartData,
      setSampleDatesChartData
    );
  };

  const updateDate = (date: string) => {
    // Check if any data is fetched at all for the date
    const metaHash = statVar.value.metahash || BEST_AVAILABLE_METAHASH;
    let placeStatData = false;
    if (
      metaHash in sampleDatesChartData &&
      date in sampleDatesChartData[metaHash]
    ) {
      for (const place in sampleDatesChartData[metaHash][date]
        .enclosedPlaceStat) {
        if (
          sampleDatesChartData[metaHash][date].enclosedPlaceStat[place].value
        ) {
          placeStatData = true;
          break;
        }
      }
    }
    statVar.setDate(date);

    // Skip update if date has no data
    if (
      placeStatData ||
      (metaHash !== BEST_AVAILABLE_METAHASH &&
        sampleDatesChartData[metaHash][date].allEnclosedPlaceStat[metaHash])
    ) {
      loadChartData(
        chartStore,
        sampleDatesChartData[metaHash][date],
        placeInfo.value,
        allSampleDates,
        statVar.value,
        setChartData,
        display
      );
    }
  };

  return (
    <div className="chart-region">
      <Chart
        geoJsonData={chartStore.geoJson.data}
        mapDataValues={chartData.mapValues}
        metadata={chartData.metadata}
        breadcrumbDataValues={breadcrumbValues}
        dates={chartData.dates}
        sources={chartData.sources}
        unit={chartData.unit}
        mapPointValues={chartData.mapPointValues}
        mapPoints={chartStore.mapPointCoordinate.data}
        europeanCountries={europeanCountries}
        rankingLink={chartData.rankingLink}
        facetInfo={facetInfo}
        sampleDates={chartData.sampleDates}
        metahash={chartData.metahash}
        onPlay={onPlay}
        updateDate={updateDate}
        geoRaster={chartStore.geoRaster.data}
        mapType={mapType}
      />
      {placeInfo.value.parentPlaces && (
        // Should separate out placeInfo into individual state.
        // The parentPlaces is only used for breadcumb section.
        <PlaceDetails
          breadcrumbDataValues={breadcrumbValues}
          mapDataValues={chartData.mapValues}
          metadata={chartData.metadata}
          unit={chartData.unit}
          geoJsonFeatures={
            chartStore.geoJson.data ? chartStore.geoJson.data.features : []
          }
          europeanCountries={europeanCountries}
        />
      )}
      <BqModal getSqlQuery={getSqlQuery} showButton={true} />
    </div>
  );

  // TODO: add unit test for this
  function getSqlQuery(): string {
    let date = "";
    const cappedDate = getCappedStatVarDate(statVar.value.dcid);
    // If there is a specified date, get the data for that date. If no specified
    // date, still need to cut data for prediction data that extends to 2099
    if (statVar.value.date) {
      date = statVar.value.date;
    } else if (cappedDate) {
      date = cappedDate;
    }
    let metadata: StatMetadata = {};
    if (rawData && statVar.value.metahash in rawData.metadataMap) {
      metadata = rawData.metadataMap[statVar.value.metahash];
    }
    if (statVar.value.perCapita) {
      return getPcQuery(statVar.value, placeInfo.value, date, metadata);
    } else {
      return getNonPcQuery(statVar.value, placeInfo.value, date, metadata);
    }
  }
}

function getFacetInfo(
  statVar: StatVar,
  placeStats: EntityObservationList,
  metadataMap: Record<string, StatMetadata>
): FacetSelectorFacetInfo {
  const filteredMetadataMap: Record<string, StatMetadata> = {};
  for (const place in placeStats) {
    for (const obs of placeStats[place]) {
      if (obs.facet in metadataMap) {
        filteredMetadataMap[obs.facet] = metadataMap[obs.facet];
      }
    }
  }
  return {
    dcid: statVar.dcid,
    metadataMap: filteredMetadataMap,
    name:
      statVar.dcid in statVar.info
        ? statVar.info[statVar.dcid].title
        : statVar.dcid,
  };
}

// Fetches the data needed for the charts.
// TODO: extract groups of cohesive promises
function fetchData(
  placeInfo: PlaceInfo,
  statVar: StatVar,
  isLoading: IsLoadingWrapper,
  setRawData: (data: ChartRawData) => void,
  showTimeSlider: boolean,
  allSampleDates: Record<string, string[]>,
  currentSampleDates?: Array<string>,
  sampleDatesChartData?: Record<string, Record<string, ChartRawData>>,
  setSampleDatesChartData?: (
    data: Record<string, Record<string, ChartRawData>>
  ) => void
): void {
  isLoading.setIsDataLoading(true);
  if (!statVar.dcid) {
    return;
  }
  const breadcrumbPlaceDcids = placeInfo.parentPlaces.map(
    (namedPlace) => namedPlace.dcid
  );
  breadcrumbPlaceDcids.push(placeInfo.selectedPlace.dcid);

  const enclosedPlacePopPromise: Promise<SeriesApiResponse> = statVar.denom
    ? axios
        .get("/api/observations/series/within", {
          params: {
            child_type: placeInfo.enclosedPlaceType,
            parent_entity: placeInfo.enclosingPlace.dcid,
            variables: [statVar.denom],
          },
          paramsSerializer: stringifyFn,
        })
        .then((resp) => resp.data)
    : Promise.resolve({});
  let dataDate = "";
  const cappedDate = getCappedStatVarDate(statVar.dcid);
  // If there is a specified date, get the data for that date. If no specified
  // date, still need to cut data for prediction data that extends to 2099
  if (statVar.date) {
    dataDate = statVar.date;
  } else if (cappedDate) {
    dataDate = cappedDate;
  }
  const enclosedPlaceDataPromise: Promise<PointApiResponse> = axios
    .get("/api/observations/point/within", {
      params: {
        child_type: placeInfo.enclosedPlaceType,
        date: dataDate,
        parent_entity: placeInfo.enclosingPlace.dcid,
        variables: [statVar.dcid],
      },
      paramsSerializer: stringifyFn,
    })
    .then((resp) => resp.data);
  const allEnclosedPlaceDataPromise: Promise<PointAllApiResponse> = axios
    .get("/api/observations/point/within/all", {
      params: {
        child_type: placeInfo.enclosedPlaceType,
        date: dataDate,
        parent_entity: placeInfo.enclosingPlace.dcid,
        variables: [statVar.dcid],
      },
      paramsSerializer: stringifyFn,
    })
    .then((resp) => resp.data);

  // Optionally compute for each sample date
  const enclosedPlaceDatesList: Array<Promise<PointApiResponse>> = [];
  const allEnclosedPlaceDatesList: Array<Promise<PointAllApiResponse>> = [];
  const breadcrumbPlaceDatesList: Array<Promise<PointApiResponse>> = [];
  if (currentSampleDates && showTimeSlider) {
    for (const i in currentSampleDates) {
      enclosedPlaceDatesList.push(
        axios
          .get("/api/observations/point/within", {
            params: {
              child_type: placeInfo.enclosedPlaceType,
              date: currentSampleDates[i],
              parent_entity: placeInfo.enclosingPlace.dcid,
              variables: [statVar.dcid],
            },
            paramsSerializer: stringifyFn,
          })
          .then((resp) => resp.data)
      );
      allEnclosedPlaceDatesList.push(
        axios
          .get("/api/observations/point/within/all", {
            params: {
              child_type: placeInfo.enclosedPlaceType,
              date: currentSampleDates[i],
              parent_entity: placeInfo.enclosingPlace.dcid,
              variables: [statVar.dcid],
            },
            paramsSerializer: stringifyFn,
          })
          .then((resp) => resp.data)
      );
      breadcrumbPlaceDatesList.push(
        axios
          .get("/api/observations/point", {
            params: {
              date: currentSampleDates[i],
              entities: breadcrumbPlaceDcids,
              variables: [statVar.dcid],
            },
            paramsSerializer: stringifyFn,
          })
          .then((resp) => {
            return resp.data;
          })
      );
    }
  }
  const enclosedPlaceDatesPromise = Promise.all(enclosedPlaceDatesList);
  const allEnclosedPlaceDatesPromise = Promise.all(allEnclosedPlaceDatesList);
  const breadcrumbPlaceDatesPromise = Promise.all(breadcrumbPlaceDatesList);

  const statVarSummaryPromise: Promise<StatVarSummary> = axios
    .post("/api/stats/stat-var-summary", { statVars: [statVar.dcid] })
    .then((resp) => resp.data);
  Promise.all([
    enclosedPlacePopPromise,
    enclosedPlaceDataPromise,
    allEnclosedPlaceDataPromise,
    statVarSummaryPromise,
    enclosedPlaceDatesPromise,
    allEnclosedPlaceDatesPromise,
    breadcrumbPlaceDatesPromise,
  ])
    .then(
      ([
        enclosedPlacesPop,
        enclosedPlaceData,
        allEnclosedPlaceData,
        statVarSummary,
        enclosedPlaceDatesData,
        allEnclosedPlaceDatesData,
        breadcrumbPlaceDatesData,
      ]) => {
        // Stat data
        const enclosedPlaceStat = enclosedPlaceData.data[statVar.dcid];
        // All stat data
        const allEnclosedPlaceStat = allEnclosedPlaceData.data[statVar.dcid];
        // Metadata map
        let metadataMap = enclosedPlaceData.facets;
        metadataMap = Object.assign(metadataMap, allEnclosedPlaceData.facets);
        if (enclosedPlacesPop && enclosedPlacesPop.facets) {
          Object.assign(metadataMap, enclosedPlacesPop.facets);
        }
        let legendBounds: Record<string, [number, number, number]> = {};
        if (BEST_AVAILABLE_METAHASH in allSampleDates) {
          // Set dates for "Best Available" to best series
          const bestAvailableHash = allSampleDates[BEST_AVAILABLE_METAHASH][0];
          allSampleDates[BEST_AVAILABLE_METAHASH] =
            allSampleDates[allSampleDates[BEST_AVAILABLE_METAHASH][0]];
          legendBounds = getLegendBounds(
            metadataMap,
            statVarSummary[statVar.dcid].provenanceSummary,
            placeInfo.enclosedPlaceType,
            bestAvailableHash
          );
        }
        isLoading.setIsDataLoading(false);
        if (currentSampleDates && showTimeSlider) {
          const currentSampleDatesData: Record<string, ChartRawData> = {};
          for (const i in currentSampleDates) {
            const enclosedPlaceStatSample =
              enclosedPlaceDatesData[i].data[statVar.dcid];
            const breadcrumbPlaceStatSample =
              breadcrumbPlaceDatesData[i].data[statVar.dcid];
            const allEnclosedPlaceStatSample =
              allEnclosedPlaceDatesData[i].data[statVar.dcid];
            currentSampleDatesData[currentSampleDates[i]] = {
              enclosedPlaceStat: enclosedPlaceStatSample,
              allEnclosedPlaceStat: allEnclosedPlaceStatSample,
              breadcrumbPlaceStat: breadcrumbPlaceStatSample,
              metadataMap,
              population: {
                ...enclosedPlacesPop.data[statVar.denom],
              },
              dataDate,
              legendBounds,
            };
          }
          let newSampleDatesChartData: Record<
            string,
            Record<string, ChartRawData>
          > = {};
          if (Object.entries(sampleDatesChartData).length > 0) {
            newSampleDatesChartData = Object.assign(
              newSampleDatesChartData,
              sampleDatesChartData
            );
          }
          newSampleDatesChartData[statVar.metahash || BEST_AVAILABLE_METAHASH] =
            currentSampleDatesData;
          setSampleDatesChartData(newSampleDatesChartData);
        } else {
          setRawData({
            enclosedPlaceStat,
            allEnclosedPlaceStat,
            breadcrumbPlaceStat: null,
            metadataMap,
            population: {
              ...enclosedPlacesPop.data[statVar.denom],
            },
            dataDate,
            legendBounds,
          });
        }
      }
    )
    .catch(() => {
      alert("Error fetching data.");
      isLoading.setIsDataLoading(false);
    });
}

function filterAllFacetData(
  data: EntityObservationList,
  targetFacet: string
): EntityObservation {
  const result = {};
  for (const place in data) {
    for (const obs of data[place]) {
      if (obs.facet == targetFacet) {
        result[place] = obs;
        break;
      }
    }
  }
  return result;
}

function getRankingLink(
  statVar: StatVar,
  placeDcid: string,
  placeType: string,
  date: string,
  unit: string
): string {
  let params = "";
  params += statVar.perCapita ? "&pc=1" : "";
  params += unit ? `&unit=${unit}` : "";
  params += date ? `&date=${date}` : "";
  return `/ranking/${statVar.dcid}/${placeType}/${placeDcid}?${params}`;
}

// Takes fetched data and processes it to be in a form that can be used for
// rendering the chart component
function loadChartData(
  chartStore: ChartStore,
  rawData: ChartRawData,
  placeInfo: PlaceInfo,
  allSampleDates: Record<string, string[]>,
  statVar: StatVar,
  setChartData: (data: ChartData) => void,
  display: DisplayOptionsWrapper
): void {
  const mapValues = {};
  const metadata = {};
  const sourceSet: Set<string> = new Set();
  const statVarDates: Set<string> = new Set();
  if (_.isNull(rawData.enclosedPlaceStat)) {
    return;
  }
  const calculateRatio = statVar.perCapita && statVar.denom ? true : false;
  // populate mapValues with data value for each geo that we have geoJson data
  // for.
  console.log("load chart data");
  for (const geoFeature of chartStore.geoJson.data.features) {
    const placeDcid = geoFeature.properties.geoDcid;
    let wantedFacetData = rawData.enclosedPlaceStat;
    if (statVar.metahash) {
      wantedFacetData = filterAllFacetData(
        rawData.allEnclosedPlaceStat,
        statVar.metahash
      );
      if (_.isEmpty(wantedFacetData)) {
        continue;
      }
    }
    const placeChartData = getPlaceChartData(
      wantedFacetData,
      placeDcid,
      calculateRatio,
      rawData.population,
      rawData.metadataMap
    );
    if (_.isEmpty(placeChartData)) {
      continue;
    }
    mapValues[placeDcid] = placeChartData.value;
    statVarDates.add(placeChartData.date);
    if (!_.isEmpty(placeChartData.metadata)) {
      metadata[placeDcid] = placeChartData.metadata;
    }
    placeChartData.sources.forEach((source) => {
      if (!_.isEmpty(source)) {
        sourceSet.add(source);
      }
    });
  }

  const mapPointValues = {};
  if (!_.isEmpty(chartStore.mapPointStat.data)) {
    for (const placeDcid in chartStore.mapPointStat.data.data) {
      const placeChartData = getPlaceChartData(
        chartStore.mapPointStat.data.data,
        placeDcid,
        false,
        {},
        chartStore.mapPointStat.data.facets
      );
      if (_.isNull(placeChartData)) {
        continue;
      }
      mapPointValues[placeDcid] = placeChartData.value;
      if (!_.isEmpty(placeChartData.metadata)) {
        metadata[placeDcid] = placeChartData.metadata;
      }
      placeChartData.sources.forEach((source) => {
        if (!_.isEmpty(source)) {
          sourceSet.add(source);
        }
      });
    }
  }
  const unit = getUnit(
    Object.values(rawData.enclosedPlaceStat),
    rawData.metadataMap
  );
  const metahash = statVar.metahash || BEST_AVAILABLE_METAHASH;
  const sampleDates = allSampleDates[metahash];

  // If not per capita and there is no user set domain, try to update the domain
  // based on rawData.
  if (
    (!statVar.perCapita || !statVar.denom) &&
    _.isEmpty(display.value.domain)
  ) {
    display.set({
      ...display.value,
      domain:
        metahash in rawData.legendBounds
          ? rawData.legendBounds[metahash]
          : undefined,
    });
  }
  setChartData({
    dates: statVarDates,
    mapPoints: chartStore.mapPointCoordinate.data,
    mapPointValues,
    mapValues,
    metadata,
    sources: sourceSet,
    unit: unit,
    rankingLink: getRankingLink(
      statVar,
      placeInfo.selectedPlace.dcid,
      placeInfo.enclosedPlaceType,
      rawData.dataDate,
      unit
    ),
    sampleDates,
    metahash,
  });
}

/**
 * Set legend bounds when per capita is selected. This will use an estimate based on
 * Best Available instead of the min/max from the StatVarSummary.
 * @param rawData
 * @param display
 */
export function setLegendBoundsPerCapita(
  rawData: ChartRawData,
  statVar: StatVarWrapper,
  display: DisplayOptionsWrapper
): void {
  const paddingScaleSmall = 0.9;
  const paddingScaleLarge = 1.1;
  let minValue: number = Number.MAX_SAFE_INTEGER;
  let maxValue = 0;
  const populationData = rawData.population;
  const stat = rawData.enclosedPlaceStat;
  for (const place in stat) {
    let value = stat[place].value;
    const date = stat[place].date;
    if (!value) {
      continue;
    }
    if (_.isEmpty(populationData || _.isEmpty(populationData[place].series))) {
      continue;
    }
    const pop = getMatchingObservation(populationData[place].series, date);
    if (!pop || pop.value === 0) {
      continue;
    }
    value /= pop.value;
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }

  // Using Best Available data as estimate - give some padding for other dates
  minValue =
    minValue > 0 ? minValue * paddingScaleSmall : minValue * paddingScaleLarge;
  maxValue =
    maxValue > 0 ? maxValue * paddingScaleLarge : maxValue * paddingScaleSmall;
  display.set({
    ...display.value,
    domain: [minValue, (minValue + maxValue) / 2, maxValue],
  });
}
