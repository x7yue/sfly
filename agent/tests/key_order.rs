//! 任务输入的键顺序：Agent 把输入解析成 `serde_json::Value`（`executor.rs`），没开 `preserve_order`，
//! 对象是 BTreeMap，写出来的键按 UTF-8 字节序排好。控制面认「节点原样打印它收到的对象」靠的就是这个顺序，
//! 用例表 `testdata/key-order-cases.json` 两端共用：这里断言真实的 serde_json 给出表里的 `sorted`，
//! 控制面一端（`apps/server/test/secret-key-order.test.ts`）断言它的排序函数给出同样的结果。

use serde_json::Value;

#[test]
fn serde_json_sorts_object_keys_like_the_shared_table() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../testdata/key-order-cases.json"
    );
    let table: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = table["cases"].as_array().expect("cases 是数组");
    assert!(cases.len() >= 6, "用例表被删空了");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = case["input"].as_str().unwrap();
        let sorted = case["sorted"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(input).unwrap();
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            sorted,
            "{name}：serde_json 写出的键顺序和用例表不一致"
        );
    }
}
