/**
 * Copyright 2023 Google LLC
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

// This component is used to show place name given the place DCID.
// It can be used in other component to fetch and show place names
// asynchronously.

import _ from "lodash";
import React, { useEffect, useState } from "react";

import { USA_NAMED_TYPED_PLACE } from "../shared/constants";
import { getPlaceDisplayNames, getPlaceNames } from "../utils/place_utils";

export interface PlaceNameProp {
  dcid: string;
  apiRoot?: string;
}

export function PlaceName(props: PlaceNameProp): JSX.Element {
  // We want the display name (gets name with state code if available) if
  // parent place is USA
  const [name, setName] = useState<string>("");
  useEffect(() => {
    const placeNamesPromise = _.isEqual(props.dcid, USA_NAMED_TYPED_PLACE.dcid)
      ? getPlaceDisplayNames([props.dcid], props.apiRoot)
      : getPlaceNames([props.dcid], props.apiRoot);

    placeNamesPromise
      .then((resp) => {
        if (props.dcid in resp) {
          setName(resp[props.dcid]);
        } else {
          setName(props.dcid);
        }
      })
      .catch(() => {
        setName(props.dcid);
      });
  }, [props.dcid, props.apiRoot]);

  return <>{name}</>;
}
