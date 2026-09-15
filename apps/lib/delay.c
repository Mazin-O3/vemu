#include <syscall.h>

#include "delay.h"

void delay(unsigned long ms)
{
    unsigned long start = sys_millis();
    while (sys_millis() - start < ms);
}

void delay_us(unsigned long us)
{
    delay((us + 999) / 1000);
}
