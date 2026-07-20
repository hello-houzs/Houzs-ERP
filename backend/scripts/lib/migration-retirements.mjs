/**
 * Exact historical migration files removed together by dfa1111a after they had
 * already reached at least one live tracker. The SQL remains recoverable from
 * Git by blob id; keeping it outside the live migration tree prevents a fresh
 * database from replaying this obsolete (and, for 0023, destructive) chain.
 *
 * A retirement is an immutable-history record, not a wildcard. The runner may
 * accept a missing tracker row only when its complete filename appears here and
 * its stored checksum is either legacy NULL or this archived SHA-256. The same
 * filename reappearing in the live migration directory always hard-fails.
 */
export const RETIRED_MIGRATIONS = Object.freeze([
  { filename: "0017_scm_suppliers.sql", archivedChecksum: "sha256:656633d7475c43679fcfad436c97e09379cbb6a856cfe3efc6726a0146623533", gitBlob: "a3b76665449b1fc102670670b7bb1e9d0d868d82" },
  { filename: "0018_scm_purchase_orders.sql", archivedChecksum: "sha256:054dba7913e58e54c79571f451272732c6b8bea421ece2d3ae03b2289b949edc", gitBlob: "b79e56cc0f06f70212a8abbe539daab0f39796fd" },
  { filename: "0019_scm_inventory.sql", archivedChecksum: "sha256:b6bdb6c7b8630098023736094e13b5536ebea243ee13124bd2ed93cd49054646", gitBlob: "0d0da006828d2730f9d3d087882515ab6aedb646" },
  { filename: "0020_scm_goods_receipts.sql", archivedChecksum: "sha256:5dc06f9bacf9a0cf83eb467b97810bf1fe177ad7938df591081b26fc8a045682", gitBlob: "24c2eb8df7af27f51937d5c63e7f83fd508d4004" },
  { filename: "0021_scm_purchase_billing.sql", archivedChecksum: "sha256:7f7afbf1dbb1871c56143e2e8176ddd18b5707b519821dddec8faa5b75025bda", gitBlob: "164a31935c555e2c26d12106657f12bb6f4dfbd0" },
  { filename: "0022_scm_transfers_stocktake.sql", archivedChecksum: "sha256:4c831b25c4381a579caeab028838c464a30e49967c76a5a8edbadd07a6bf8811", gitBlob: "0e5cc6d44f5f97d8f5660a7316cf190a427ff766" },
  { filename: "0023_drop_adapted_scm_island.sql", archivedChecksum: "sha256:1c7a0fd684c1fb3223bf6e170e3ae2b70fc6f33b5278c2615e5fa9bbe448a19a", gitBlob: "6870426489c0cbf3012bb005860055f30667d26e" },
  { filename: "0024_suppliers.sql", archivedChecksum: "sha256:cf2fed64d11b6f7464a8f2c71da60b1f8829582ed87d9d1fb9f15f288d2396c2", gitBlob: "d6d95a295f34a593a52c46ec0e2a3d6b502ebfb0" },
  { filename: "0025_purchase_orders.sql", archivedChecksum: "sha256:c01c504e85a30f6309ba27b5fd994b231aff510e817100b077569f314f08a251", gitBlob: "1bc746d99ba01c7563104144db142c2df2ea84ba" },
  { filename: "0026_inventory_warehouse.sql", archivedChecksum: "sha256:a0a3d92d10dbdca8cbf6cabda326e95a569e1fca3629548a6f42419ea8c7513b", gitBlob: "58abbe8bf03634e3f9d9294b9ec476ca28289e1c" },
  { filename: "0027_grns.sql", archivedChecksum: "sha256:8d3235745637ea963a67e547325e5479160c4b9e24c920dc603f837ce9bc1b5d", gitBlob: "2912a11e4fa0c7922b02a88525a68545ed7844e6" },
  { filename: "0028_purchase_billing.sql", archivedChecksum: "sha256:b15e488d341c25149d72116ba253e5cf26595db0bb0900c2314e3b8d24c24fbf", gitBlob: "48b5c54b0153125fe7c9f471eb78d91244cf117c" },
  { filename: "0029_sales_orders.sql", archivedChecksum: "sha256:238749fd7a10dbda5c28e426690c38569944238729d61a3cbbde40b05399811d", gitBlob: "347891980110ad20e6f980ecc28f6fa2a0769e72" },
  { filename: "0030_delivery_billing.sql", archivedChecksum: "sha256:67ee8032e4a161f595b0c82b2c4cc9d40f78c85a1cc0741b0a2638f86b41ec20", gitBlob: "4f9364ebf209e26f4df23e77422199e8cdcba56e" },
  { filename: "0031_consignment.sql", archivedChecksum: "sha256:201ae13964abf13dc0cc3cedc66788d6ede38181602eb5124bdcd5b0939104d5", gitBlob: "e14d4f91fe5cc32113c6e8a0f94d55f42e72f114" },
  { filename: "0032_mrp_lead_times.sql", archivedChecksum: "sha256:61a616ead0fda0969ef62d32cee8bfa92d5f144f256f17f3f2adb1a505fd87ed", gitBlob: "f0a870445d562c69de63a09b55ec6b52e882acc5" },
  { filename: "0033_products_maintenance.sql", archivedChecksum: "sha256:89cc7f4f90e8085b6a4d1aa123e86b34cb9471ca90ea0082c7473ca7b8bd5dde", gitBlob: "8c1a7cdf0c05c1e0ad2ad438e751459e02c863f3" },
]);

export const RETIRED_MIGRATION_FILENAMES = Object.freeze(
  RETIRED_MIGRATIONS.map((entry) => entry.filename),
);
