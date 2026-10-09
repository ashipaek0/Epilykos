"""Conservative writable PSW-H settings. Bounds follow recovered APK UI."""
FLAGS={"record_fault_codes":0,"alarm_source_interrupted":1,"lcd_backlight":2,"restart_overtemperature":3,"restart_overload":4,"lcd_auto_return":5,"solar_feed_grid":6,"overload_bypass":7,"buzzer":8,"battery_equalization":9}
ENUMS={"input_range":(16,(0,1)),"output_priority":(17,(0,1,2)),"charger_priority":(18,(1,2,3)),"battery_type":(19,tuple(range(8)))}
TIMING={"equalization_duration":(6,5,120),"equalization_interval":(8,0,90),"equalization_timeout":(12,5,900),"boost_duration":(16,5,900)}
def catalogue(model, nominal_v, watts, ac_voltage):
    # Only combinations represented by the recovered model family are writable.
    supported = {("1", 24, 3000), ("1", 48, 5000), ("9", 24, 3000), ("9", 48, 5000), ("9", 48, 6500)}
    if (model, nominal_v, watts) not in supported:
        raise ValueError("unknown or unsupported model/rating combination")
    if ac_voltage is not None and ac_voltage not in (120, 230):
        raise ValueError("unknown or unsupported nominal AC output rating")
    limit=120 if watts==6500 else 80
    out={k:{"characteristic":"2a0d","offset":0,"width":2,"type":"bool","bit":b,"risk":"low"} for k,b in FLAGS.items()}
    for k,(o,vals) in ENUMS.items(): out[k]={"characteristic":"2a0c","offset":o,"width":1,"type":"enum","allowed":vals,"risk":"medium"}
    for k,(o,lo,hi) in TIMING.items(): out[k]={"characteristic":"2a0d","offset":o,"width":2,"type":"int","min":lo,"max":hi,"risk":"medium"}
    out.update({"output_voltage":{"characteristic":"2a0c","offset":0,"width":2,"type":"enum","allowed":(110,120,127) if ac_voltage==120 else (220,230,240)},"output_frequency":{"characteristic":"2a0c","offset":2,"width":2,"type":"enum","scale":10,"allowed":(50,60)},"max_charging_current":{"characteristic":"2a0c","offset":4,"width":1,"type":"int","min":0,"max":limit},"max_utility_charging_current":{"characteristic":"2a0c","offset":5,"width":1,"type":"int","min":0,"max":limit},"float_voltage":{"characteristic":"2a0c","offset":6,"width":2,"type":"float","scale":10,"min":nominal_v,"max":nominal_v+16},"boost_voltage":{"characteristic":"2a0c","offset":8,"width":2,"type":"float","scale":10,"min":nominal_v,"max":nominal_v+16},"disconnect_voltage":{"characteristic":"2a0c","offset":10,"width":2,"type":"float","scale":10,"min":18.8 if nominal_v==24 else 37.5,"max":27 if nominal_v==24 else 54},"recharge_voltage":{"characteristic":"2a0c","offset":12,"width":2,"type":"float","scale":10,"min":22 if nominal_v==24 else 44,"max":28.5 if nominal_v==24 else 57},"discharge_current":{"characteristic":"2a0e","offset":1,"width":1,"type":"int","min":0,"max":120 if nominal_v==48 else 150}})
    return out
